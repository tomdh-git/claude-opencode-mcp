package ocd

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** One supervised session that is NOT a checklist unit (an engineering task, a research job, anything). It belongs to a named GROUP so the status shows it apart from the lift units.
 *  Tasks never occupy a lift slot, never go through the item done gate and never requeue. The daemon keeps them alive: rate limits rotate the key and re-prompt, stalls are
 *  stop-then-continue, a wrong model is reset, a gone/archived session is dropped. Done = the progress file's ## NEXT starts with DONE, or the turn succeeded and no file is tracked. */
class Task(val id: String, val name: String, val group: String, val file: File?, val prompt: String) {
    val lock = Mutex()
    @Volatile var running = false
    @Volatile var done = false
    @Volatile var stopping = false
    @Volatile var consFail = 0
    @Volatile var stallKicks = 0
    @Volatile var reminders = 0
    @Volatile var retryAt = 0L
    @Volatile var lastSend = 0L
    @Volatile var lastAct = System.currentTimeMillis()
    @Volatile var lastErr = ""
    @Volatile var succeeded = false          // the last turn ended cleanly (no restart needed unless the file says it is not DONE)
}

object Tasks {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tasks = ConcurrentHashMap<String, Task>()
    private fun now() = System.currentTimeMillis()
    fun live(): List<Task> = tasks.values.filter { !it.done }
    fun byName(n: String) = live().find { it.name == n }
    fun has(n: String) = byName(n) != null

    private fun continueText(t: Task) =
        "Your turn ended but the task is not finished" + (t.file?.let { " (your progress file is ${it.path}; re-read its ## NEXT block)" } ?: "") +
        ". Continue where you stopped; do not redo finished work. When truly finished write ## NEXT starting with DONE. ${Cfg.RULES}"

    /** create a NEW session on the daemon's model and start it: the single correct way to start an engineering task */
    suspend fun create(name: String, group: String, prompt: String, file: String?): Task? {
        if (has(name)) return null
        val id = OpenCode.act("create $name") { OpenCode.create("Task: $name") } ?: return null
        return add(id, name, group, file, prompt, send = true)
    }
    /** put an existing session under supervision (model is reset to the daemon's model) */
    suspend fun adopt(id: String, name: String, group: String, file: String?, prompt: String = ""): Task? {
        if (has(name) || tasks.containsKey(id)) return null
        runCatching { OpenCode.act("switchModel $id") { OpenCode.switchModel(id) } }
        return add(id, name, group, file, prompt, send = false)
    }
    private suspend fun add(id: String, name: String, group: String, file: String?, prompt: String, send: Boolean): Task {
        val t = Task(id, name, group, file?.let { File(if (File(it).isAbsolute) it else File(Cfg.REPO, it).path) }, prompt)
        tasks[id] = t; Store.saveTask(id, name, group, file ?: "", "running"); Log.say("TASK $group/$name $id supervised")
        if (send && prompt.isNotBlank()) { t.lastSend = now(); t.running = true; OpenCode.act("prompt $id") { OpenCode.prompt(id, prompt) } }
        return t
    }
    /** restore after a restart */
    fun restore() { for (r in Store.liveTasks()) tasks[r.id] = Task(r.id, r.name, r.group, r.file.takeIf { it.isNotEmpty() }?.let { File(if (File(it).isAbsolute) it else File(Cfg.REPO, it).path) }, "") }

    private fun drop(t: Task, state: String, why: String) {
        if (t.done) return
        t.done = true; t.running = false; Store.setTaskState(t.id, state); Log.note("TASK-" + state.uppercase(), t.group + "/" + t.name, why)
        scope.launch { delay(30_000); tasks.remove(t.id) }
    }

    private suspend fun stop(t: Task) {
        if (Cfg.SHADOW) { Store.journal("would", "", "stop ${t.id}"); return }
        t.stopping = true
        try { OpenCode.interrupt(t.id) } catch (_: Exception) {}
        for (i in 0 until 12) { delay(1000); val s = runCatching { OpenCode.session(t.id) }.getOrNull(); if (s == null || !s.generating) break }
        t.running = false; scope.launch { delay(3000); t.stopping = false }
    }
    private suspend fun send(t: Task, text: String) { t.lastSend = now(); t.running = true; t.succeeded = false; OpenCode.act("prompt ${t.id}") { OpenCode.prompt(t.id, text) } }

    /** this task's turn ended: finish it, or continue it (rate limited per task, exponential backoff after failures) */
    suspend fun handle(t: Task, why: String) {
        if (t.done) return
        if (t.file != null && Repo.isDone(t.file)) { drop(t, "done", "file says DONE"); return }
        if (Pool.paused) return
        if (!t.lock.tryLock()) return
        try {
            val wait = maxOf(t.retryAt, t.lastSend + Cfg.MIN_GAP_MS) - now()
            if (wait > 0) { scope.launch { delay(wait + 200); handle(t, "$why (delayed)") }; return }
            val s = try { OpenCode.session(t.id) ?: run { drop(t, "gone", "session gone"); return } } catch (_: Exception) { return }
            if (s.archived && !s.generating) { drop(t, "gone", "session archived outside the daemon"); return }
            if (s.generating) { t.running = true; return }
            if (why == "succeeded" && t.consFail == 0) {
                if (t.file == null) { drop(t, "done", "turn succeeded (no progress file tracked)"); return }
                if (++t.reminders > 2) { drop(t, "done", "turn succeeded, ## NEXT never says DONE (check its file)"); return }
            }
            send(t, continueText(t)); Log.log(t.name, "task continue sent ($why)")
        } catch (e: Exception) { if (e is CancellationException) throw e; Log.log(t.name, "task handle error", e.toString().take(120)) }
        finally { t.lock.unlock() }
    }

    suspend fun onEvent(e: OcEvent) {
        val t = e.sessionId?.let { tasks[it] } ?: return
        if (t.done) return
        when (e) {
            is OcEvent.Activity -> { t.lastAct = now(); if (e.type == "session.step.ended") { t.consFail = 0; t.stallKicks = 0; t.retryAt = 0 } }
            is OcEvent.StepStarted -> { t.running = true; t.lastAct = now() }
            is OcEvent.ExecutionSucceeded -> { t.running = false; t.consFail = 0; t.succeeded = true; scope.launch { handle(t, "succeeded") } }
            is OcEvent.ExecutionFailed -> {
                t.running = false; t.lastErr = e.data.sub("error")?.str("message")?.take(100) ?: e.errorType
                Log.note("TASK-FAILED", t.group + "/" + t.name, (if (e.isQuota) "rate limit/quota: " else "") + t.lastErr)
                if (e.isQuota) Pool.onQuota("task ${t.name}: quota")
                if (e.errorType == "provider.no-route") runCatching { OpenCode.act("switchModel") { OpenCode.switchModel(t.id) } }
                val n = ++t.consFail
                t.retryAt = now() + minOf(120_000L, 10_000L shl minOf(n - 1, 4))
                scope.launch { handle(t, "failed") }
            }
            is OcEvent.ExecutionInterrupted -> { t.running = false; if (!t.stopping) scope.launch { delay(2000); handle(t, "interrupted") } }
            is OcEvent.RetryScheduled -> if (e.isQuota) scope.launch { Pool.onQuota("task ${t.name}: retry quota") }
            else -> {}
        }
    }

    fun onBus(e: BusEvent) {
        if (e is BusEvent.KeysRecovered || e is BusEvent.KeyRotated) { for (t in live()) { t.consFail = 0; t.retryAt = 0 }; scope.launch { reconcile(force = true) } }
    }

    private val reconciling = Mutex()
    /** every 30 s: compare each task with its real session; kick stalled ones (stop, wait, continue); re-prompt idle failed ones */
    suspend fun reconcile(force: Boolean = false) {
        if (!reconciling.tryLock()) return
        try {
            for (t in live()) {
                if (t.file != null && Repo.isDone(t.file)) { drop(t, "done", "file says DONE"); continue }
                if (t.lock.isLocked) continue
                val answered = try { Result.success(OpenCode.session(t.id)) } catch (e: Exception) { Result.failure(e) }
                if (answered.isFailure) continue
                val s = answered.getOrNull()
                if (s == null) { drop(t, "gone", "session gone"); continue }
                if (s.archived && !s.generating) { drop(t, "gone", "session archived outside the daemon"); continue }
                t.running = s.generating
                if (s.generating) {
                    val lastReal = maxOf(t.lastAct, t.file?.let { Repo.mtime(it) } ?: 0L)
                    if (!Pool.paused && !t.stopping && now() - lastReal > Cfg.STALL_MS) {
                        val n = ++t.stallKicks; t.lastAct = now()
                        Log.note("TASK-STALL", t.group + "/" + t.name, "no model activity and no file write for ${Cfg.STALL_MS / 1000}s+ (kick $n)")
                        stop(t); scope.launch { handle(t, "stall") }
                    }
                } else if (!t.stopping && !t.succeeded && now() >= t.retryAt && (force || now() - t.lastSend > Cfg.MIN_GAP_MS)) scope.launch { handle(t, "reconcile: idle after failure") }
            }
        } finally { reconciling.unlock() }
    }

    suspend fun nudge(name: String, text: String): Boolean {
        val t = byName(name) ?: return false
        t.consFail = 0; t.retryAt = 0; t.lastSend = 0
        val s = runCatching { OpenCode.session(t.id) }.getOrNull()
        if (s != null && s.generating) stop(t)
        send(t, "ORCHESTRATOR NUDGE (read, apply, continue the task): $text ${Cfg.RULES}"); Log.note("TASK-NUDGE", t.group + "/" + t.name, text.take(100)); return true
    }

    fun statusJson(): JsonObject = buildJsonObject {
        val groups = tasks.values.groupBy { it.group }
        for ((g, ts) in groups) put(g, buildJsonObject {
            put("live", ts.count { !it.done }); put("generating", ts.count { !it.done && it.running })
            put("tasks", buildJsonArray { ts.forEach { t -> add(buildJsonObject {
                put("name", t.name); put("id", t.id); put("running", t.running); put("done", t.done); put("consFail", t.consFail); put("stallKicks", t.stallKicks)
                put("actIdleS", (now() - maxOf(t.lastAct, t.file?.let { Repo.mtime(it) } ?: 0L)) / 1000); put("lastErr", t.lastErr)
            }) } })
        })
    }
}
