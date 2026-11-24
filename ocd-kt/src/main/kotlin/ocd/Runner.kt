package ocd

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** One live unit. Everything the runner decides about it is a typed field here; the SESSION (opencode) stays the source of truth. */
class UnitRun(val id: String, val name: String, val file: File) {
    val lock = Mutex()                       // one decision at a time per unit
    @Volatile var running = false            // generating now (synced from the session by reconcile)
    @Volatile var done = false
    @Volatile var stopping = false           // WE interrupted it: the interrupted event is expected
    @Volatile var again = false
    @Volatile var noProg = 0
    @Volatile var tokAtSend = 0L
    @Volatile var fileAtSend = 0L
    @Volatile var intAuto = 0
    @Volatile var stallKicks = 0
    @Volatile var consFail = 0
    @Volatile var toolFails = 0
    @Volatile var lastTool = ""
    @Volatile var lastEv = System.currentTimeMillis()
    @Volatile var lastAct = System.currentTimeMillis()
    @Volatile var lastSend = 0L
    @Volatile var retryAt = 0L
    @Volatile var spawns = 0
    @Volatile var ctx = 0L
}

/** L2 unit runner: the life of one unit. The session itself is the truth (generating = busy newer than idle, archived, last assistant message), never our own flags.
 *  A unit that makes no progress is ROTATED (fresh session, same progress file) a bounded number of times, then RETIRED (session archived, item requeues through nextitems).
 *  Every interruption is stop-then-send: interrupt, WAIT until the session really stopped, only then prompt (a prompt to a busy session only queues). Sends are rate-limited per unit. */
object Runner {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val units = ConcurrentHashMap<String, UnitRun>()
    private val ours = ConcurrentHashMap<String, Boolean>()
    private val rotations = ConcurrentHashMap<String, MutableList<Long>>()
    private val gateFails = ConcurrentHashMap<String, Int>()
    private val seenUnknown = ConcurrentHashMap.newKeySet<String>()

    fun live(): List<UnitRun> = units.values.filter { !it.done }
    fun byName(n: String) = live().find { it.name == n }
    fun rotationCount(name: String) = (rotations[name] ?: emptyList<Long>()).count { System.currentTimeMillis() - it < 6 * 3600_000L }
    private fun now() = System.currentTimeMillis()

    // ---- helpers over the real session
    /** interrupt and WAIT until the session has really stopped */
    private suspend fun stop(u: UnitRun) {
        if (Cfg.SHADOW) { Store.journal("would", "", "stop ${u.id}"); return }
        u.stopping = true
        try { OpenCode.interrupt(u.id) } catch (_: Exception) {}
        repeat(12) { delay(1000); val s = runCatching { OpenCode.session(u.id) }.getOrNull(); if (s == null || !s.generating) return@repeat }
        u.running = false; scope.launch { delay(3000); u.stopping = false }
    }
    private suspend fun send(u: UnitRun, text: String) { u.lastSend = now(); u.running = true; OpenCode.act("prompt ${u.id}") { OpenCode.prompt(u.id, text) } }
    private fun forget(u: UnitRun) { units.remove(u.id) }

    /** remove a unit from the daemon (the session is archived unless it already is). The progress file stays; the item requeues through nextitems. */
    suspend fun retire(u: UnitRun, why: String, archive: Boolean = true) {
        if (u.done) return
        u.done = true; u.running = false; Store.setState(u.id, "retired"); Log.note("RETIRED", u.name, why)
        if (archive) { OpenCode.act("interrupt ${u.id}") { OpenCode.interrupt(u.id) }; delay(1500); OpenCode.act("archive ${u.id}") { OpenCode.setArchived(u.id, true) } }
        forget(u); Bus.emit(BusEvent.UnitFinished(u.name))
    }
    /** fresh session for the same item: the progress file and the source files already written carry the state */
    private suspend fun rotate(u: UnitRun, why: String) {
        if (u.done) return
        val rs = rotations.getOrPut(u.name) { mutableListOf() }.also { l -> l.removeAll { now() - it >= 6 * 3600_000L } }
        if (rs.size >= Cfg.MAX_ROT) { retire(u, "rotation budget used (${Cfg.MAX_ROT}/6h), last reason: $why"); return }
        rs.add(now()); Log.note("ROTATE", u.name, "$why: fresh session (${rs.size}/${Cfg.MAX_ROT}), the progress file carries the state")
        if (Cfg.SHADOW) return
        val base = runCatching { File(Cfg.PROG, "_p_${u.name}.txt").readText() }.getOrDefault("")
        if (base.isEmpty()) { retire(u, "rotate: no prompt file to restart from, retiring ($why)"); return }
        val sid = try { OpenCode.create(u.name) } catch (e: Exception) { Log.log(u.name, "rotate: create failed", e.toString().take(100)); return }
        u.done = true; u.running = false; forget(u); Store.setState(u.id, "retired")
        runCatching { OpenCode.interrupt(u.id) }; scope.launch { delay(2000); runCatching { OpenCode.setArchived(u.id, true) } }
        val n = UnitRun(sid, u.name, u.file).also { it.running = true; it.lastSend = now() }; units[sid] = n; Store.startUnit(sid, u.name, u.file.path)
        OpenCode.prompt(sid, base + "\nCONTINUATION: an earlier session of this unit was replaced ($why). Do NOT start over: your progress file ${u.file.path} and the source files already written hold the state. Read the progress file (## NEXT), check the source files it names, and continue exactly where it stops. ${Cfg.RULES}")
        Bus.emit(BusEvent.UnitStarted(u.name))
    }

    // ---- startup / start
    suspend fun adopt(rows: List<Triple<String, String, String>>) {
        for ((id, name, file) in rows) {
            val f = File(file); if (Repo.isDone(f)) continue
            val s = runCatching { OpenCode.session(id) }.getOrNull() ?: continue
            if (s.archived && !s.generating) continue
            units[id] = UnitRun(id, name, f).also { it.running = s.generating }; Store.startUnit(id, name, file)
        }
        Log.log("adopted", units.size, "units")
        for (u in live()) runCatching { for ((fid, title) in OpenCode.forms(u.id)) cancelForm(u.id, fid, title) }
    }
    /** L3 calls this when a slot is free and the head of the queue passed its checks */
    suspend fun start(e: QueueRow) {
        Repo.archivePrevOutput(e.name, File(e.file))
        for (old in live().filter { it.name == e.name && it.id != e.id }) retire(old, "replaced by a queued session of the same item")
        val u = UnitRun(e.id, e.name, File(e.file)).also { it.running = true; it.lastSend = now() }; units[e.id] = u; Store.startUnit(e.id, e.name, e.file)
        OpenCode.act("prompt ${e.id}") { OpenCode.prompt(e.id, File(e.promptFile).readText()) }
        Bus.emit(BusEvent.UnitStarted(e.name))
    }

    // ---- done gate: chunk units must quote every listed instruction (tools/chunkcheck.py); otherwise the unit is reopened with the exact missing lines
    private suspend fun doneGate(u: UnitRun): Boolean {
        val nm = u.name.removePrefix("U-")
        if (!File(Cfg.PROG, "_part_$nm.txt").exists()) return true
        val out = withContext(Dispatchers.IO) { py("tools/chunkcheck.py", u.name).first }
        val miss = out.lines().filter { it.startsWith("MISSING ") }.map { it.substring(8) }
        val cov = Regex("(\\d+)/(\\d+) instructions quoted").find(out)?.value
        if (miss.isEmpty() && "CHECK OK" in out) return true
        if (cov == null) { Log.say(u.name, "GATE: no coverage line (transient)"); return false }
        val n = gateFails.merge(u.id, 1, Int::plus)!!
        if (n > 4) { Log.say(u.name, "GATE: still failing after 4 tries, accepting for review ($cov)"); return true }
        fun reopen(txt: String) { if (Cfg.SHADOW) return; runCatching { u.file.writeText(u.file.readText().replace(Regex("^(## NEXT\\s*\\n)\\s*(DONE|COMPLETE)[^\\n]*", RegexOption.MULTILINE), "$1$txt")) } }
        if (miss.isEmpty()) {
            val fails = out.lines().filter { it.startsWith("- ") }.joinToString("\n")
            Log.say(u.name, "GATE: DONE rejected (coverage ok, structure check failed), sending failures back"); reopen("step 3: fix the failures sent by the orchestrator")
            send(u, "Your DONE was rejected by `python tools/delegate.py check ${u.file.path}`. Fix exactly these failures in ${u.file.path} (do not rewrite the whole file, keep every quoted instruction line), rerun the check until it prints CHECK OK, then set the line after ## NEXT to DONE:\n$fails\n${Cfg.RULES}")
        } else {
            Log.say(u.name, "GATE: DONE rejected ($cov), sending back ${miss.size} missing lines"); reopen("step 3: the orchestrator found missing instructions, append them (see message)")
            send(u, "Your DONE was rejected by the coverage check: $cov. These listed instructions are not quoted anywhere in ${u.file.path} (quote each as `0xRVA  instr` inside phases, append them, do not rewrite the file):\n${miss.joinToString("\n")}\nThen run `python tools/chunkcheck.py ${u.name}` until it prints no MISSING lines and set the line after ## NEXT to DONE. ${Cfg.RULES}")
        }
        u.running = true; return false
    }
    private fun finish(u: UnitRun) {
        u.done = true; u.running = false; Store.setState(u.id, "done"); Log.say(u.name, u.id, "DONE (file says complete)")
        if (!Cfg.SHADOW) pyDetached("tools/triage.py", u.name)
        scope.launch { delay(30_000); runCatching { OpenCode.act("archive ${u.id}") { OpenCode.setArchived(u.id, true) } }; forget(u) }
        Bus.emit(BusEvent.UnitFinished(u.name))
    }

    // ---- continue / answer: the single decision point for "this unit's turn ended"
    suspend fun handle(u: UnitRun, why: String) {
        if (u.done) return
        if (Repo.isDone(u.file)) { if (!doneGate(u) || u.done) return; finish(u); return }
        if (Pool.paused) { Log.log(u.name, "paused: all keys cooling"); return }
        if (!u.lock.tryLock()) { u.again = true; return }
        try {
            val wait = maxOf(u.retryAt, u.lastSend + Cfg.MIN_GAP_MS) - now()
            if (wait > 0) { scope.launch { delay(wait + 200); handle(u, "$why (delayed)") }; return }   // rate limit / failure backoff: later, not never
            val s = try { OpenCode.session(u.id) ?: run { retire(u, "session gone", archive = false); return } } catch (_: Exception) { return }
            if (s.archived && !s.generating) { retire(u, "session archived outside the daemon", archive = false); return }
            if (s.generating) { u.running = true; return }                  // really generating: nothing to do
            val msgs = OpenCode.context(u.id); val last = msgs.lastOrNull()
            if (last != null && (last.role == Role.USER || (last.role == Role.ASSISTANT && last.completed == null)) && now() - last.created < 90_000) { u.running = true; Log.log(u.name, "busy (${last.role}), no send"); return }
            u.ctx = msgs.sumOf { it.approxTokens }
            if (u.ctx > Cfg.CTX_MAX) { rotate(u, "context ~${u.ctx / 1000}k tokens (> ${Cfg.CTX_MAX / 1000}k)"); return }
            // progress = the session spent tokens OR the progress file moved since the last send
            val tok = s.tokens.total; val fm = Repo.mtime(u.file)
            if (u.lastSend != 0L) { if (tok - u.tokAtSend >= 1500 || fm > u.fileAtSend) u.noProg = 0 else u.noProg++ }
            if (u.noProg >= Cfg.NOPROG_MAX) { rotate(u, "${Cfg.NOPROG_MAX} sends without progress"); return }
            val la = msgs.lastOrNull { it.role == Role.ASSISTANT }; val texts = la?.text ?: ""
            val asked = la != null && (la.usedQuestionTool || (last === la && la.completed != null && Regex("\\?\\s*$").containsMatchIn(texts)))
            u.tokAtSend = tok; u.fileAtSend = fm
            if (asked) { Log.say("QUESTION", u.name, texts.takeLast(200).replace("\n", " ")); send(u, "${Cfg.NOQ} Your question was: ${texts.takeLast(300)} ${Cfg.RULES}") }
            else { send(u, "Your turn ended but the unit is not finished (if your progress file ${u.file.path} is missing, create it now). Re-read it (## NEXT) and continue. ${Cfg.RULES}"); Log.log(u.name, "continue sent ($why)") }
        } catch (e: Exception) { if (e is CancellationException) throw e; Log.log(u.name, "handle error", e.toString().take(120)) }
        finally { u.lock.unlock(); if (u.again) { u.again = false; scope.launch { delay(1000); handle(u, "again") } } }
    }
    fun sweep(why: String) { for (u in live()) if (!u.running) scope.launch { handle(u, why) } }

    private suspend fun cancelForm(sessionId: String, formId: String, title: String) {
        try { OpenCode.act("cancel form") { OpenCode.cancelForm(sessionId, formId, "${Cfg.NOQ} (the form was cancelled automatically: ${title.take(120)})") }; Log.say("QUESTION auto-cancelled form in", sessionId, title.take(120)) } catch (e: Exception) { Log.log("form cancel failed", e.toString().take(120)) }
    }
    private suspend fun rejectPermission(sessionId: String, requestId: String) {
        try { OpenCode.act("reject permission") { OpenCode.replyPermission(sessionId, requestId, "reject", "Orchestrator: permission requests are not answered during the run. Use only repo files, bash with python tools/sigs/*.py and rdis.exe, and write only docs/progress/*, docs/listings/*, tools/sigs/*. Continue the unit without it.") }; Log.say("PERMISSION auto-rejected in", sessionId) } catch (e: Exception) { Log.log("permission reply failed", e.toString().take(120)) }
    }
    /** is this session a unit, or a subagent (child) of one? */
    private suspend fun isOurs(sid: String): Boolean {
        ours[sid]?.let { return it }
        var id: String? = sid; var ok = false
        for (d in 0 until 5) { val cur = id ?: break; if (units.containsKey(cur)) { ok = true; break }; id = runCatching { OpenCode.session(cur)?.parentID }.getOrNull() }
        ours[sid] = ok; return ok
    }
    suspend fun interruptAll() {
        for (u in live()) { u.stopping = true; OpenCode.act("interrupt ${u.id}") { OpenCode.interrupt(u.id) }; u.running = false; scope.launch { delay(5000); u.stopping = false } }
        delay(2500); Log.log("interrupted all unit chats")
    }
    fun onBus(e: BusEvent) {
        when (e) {
            BusEvent.KeysExhausted -> scope.launch { interruptAll() }                  // nothing keeps firing into dead keys
            BusEvent.KeysRecovered -> { live().forEach { it.noProg = 0; it.consFail = 0; it.retryAt = 0 }; Log.say("KEY recovered, continuing units"); sweep("keys back") }
            is BusEvent.KeyRotated -> { live().forEach { it.noProg = 0; it.consFail = 0; it.retryAt = 0 }; sweep("rotated") }
            BusEvent.OcReconnected -> scope.launch { reconcile() }
            BusEvent.OcShutdown -> scope.launch { delay(6000); Log.say("server restarted: interrupting dead in-flight calls, then reconciling units"); interruptAll(); reconcile() }
            else -> {}
        }
    }

    // ---- opencode events: each is acted on, tracked, noted, or explicitly quiet
    private fun short(e: OcEvent) = e.data.toString().replace(Regex("\\s+"), " ").take(200)
    suspend fun onEvent(e: OcEvent) {
        val u = e.sessionId?.let { units[it] }
        if (u != null) u.lastEv = now()
        if (e.type in OcEvent.QUIET) return
        if (e is OcEvent.Activity) {
            if (u == null) return
            u.lastAct = now()
            when (e.type) {
                "session.step.ended" -> { u.intAuto = 0; u.stallKicks = 0; u.consFail = 0; u.retryAt = 0 }
                "session.tool.success" -> u.toolFails = 0
                "session.tool.called" -> u.lastTool = (e.data.str("name") ?: "") + " " + e.data.sub("input").toString().take(120)
                "session.tool.failed" -> { u.toolFails++; if (u.toolFails == 3 || u.toolFails % 10 == 0) Log.note("TOOL-FAILING", u.name, "${u.toolFails} tool failures in a row, last: ${u.lastTool.take(120)} :: ${(e.data["error"] ?: e.data).toString().take(120)}") }
            }
            return
        }
        val who = u?.name ?: (e.sessionId ?: "global")
        when (e) {
            is OcEvent.StepStarted -> if (u != null) { u.running = true; u.lastAct = now() }
            is OcEvent.ExecutionSucceeded -> if (u != null) { u.running = false; u.consFail = 0; u.intAuto = 0; u.stallKicks = 0; scope.launch { handle(u, "succeeded") }; sweep("slot free") }
            is OcEvent.ExecutionFailed -> if (u != null) {
                u.running = false; Log.note("EXECUTION-FAILED", who, short(e))
                if (e.isQuota) Pool.onQuota("execution failed: quota")
                if (e.errorType == "provider.no-route") runCatching { OpenCode.act("switchModel") { OpenCode.switchModel(u.id) }; Log.note("MODEL-RESET", who, "no-route -> ${Cfg.MODEL.id}") }
                val n = ++u.consFail
                if (n >= Cfg.FAIL_ROTATE && !e.isQuota && !e.isProviderOutage) { scope.launch { rotate(u, "$n failed executions in a row (${e.errorType})") }; return }
                u.retryAt = now() + minOf(120_000L, 5000L shl minOf(n - 1, 5))      // exponential backoff: a failing provider is not hammered
                scope.launch { handle(u, "failed") }; sweep("slot free")
            }
            is OcEvent.ExecutionInterrupted -> if (u != null) {
                u.running = false; if (u.stopping) return                                   // we interrupted it ourselves and drive the restart explicitly
                val n = ++u.intAuto
                if (!Repo.isDone(u.file) && n <= 3) { Log.note("INTERRUPTED", who, "auto-continuing ($n/3)"); scope.launch { handle(u, "interrupted") } }
                else Log.note("INTERRUPTED", who, if (Repo.isDone(u.file)) "file is DONE, nothing to continue" else "3 auto-continues used, the 30 s reconcile decides")
            }
            is OcEvent.RetryScheduled -> if (u != null) { Log.note("RETRY", who, short(e)); if (e.isQuota) scope.launch { Pool.onQuota("retry scheduled: quota") } }
            is OcEvent.BudgetLimit -> { Log.note("BUDGET-LIMIT", "global", e.type + " " + short(e)); scope.launch { Pool.onQuota(e.type) } }
            is OcEvent.FormCreated -> { val f = e.data.sub("form"); val sid = e.sessionId; if (sid != null && isOurs(sid)) cancelForm(sid, f?.str("id") ?: "", f?.str("title") ?: f.toString()) else Log.note("FORM", who, "form in a session that is not a unit's (left alone) " + f.toString().take(120)) }
            is OcEvent.PermissionAsked -> { val sid = e.sessionId; if (sid != null && isOurs(sid)) rejectPermission(sid, e.data.str("id") ?: e.data.str("requestID") ?: "") else Log.note("PERMISSION", who, "request in a session that is not a unit's (left alone)") }
            is OcEvent.StepFailed -> if (u != null) Log.note("STEP-FAILED", who, short(e).take(140)) else Log.log("step failed in non-unit session", who, short(e).take(100))
            is OcEvent.Synthetic -> { val t = short(e); if (Regex("error", RegexOption.IGNORE_CASE).containsMatchIn(t)) Log.note("SUBAGENT-ERROR", who, t) else if (u != null) Log.note("SUBAGENT-RESULT", who, t.take(120)) }
            is OcEvent.SessionCreated -> { val pid = e.data.str("parentID"); if (pid != null && isOurs(pid)) units[pid]?.let { p -> p.spawns++; if (p.spawns == 1 || p.spawns % 10 == 0) Log.note("SUBAGENT-SPAWNED", pid, "${p.spawns} subagent(s) spawned by this unit so far (rules forbid it)") } }
            is OcEvent.Compaction -> if (u != null || (e.sessionId?.let { isOurs(it) } == true)) Log.note(e.type.uppercase().removePrefix("SESSION."), who, short(e).take(120))
            is OcEvent.Shutdown, is OcEvent.Activity -> {}
            is OcEvent.Other -> when {
                e.type in OcEvent.NOTED -> Log.note(e.type.uppercase(), who, short(e).take(160))
                e.type.startsWith("rpc.") -> {}
                seenUnknown.add(e.type) -> Log.note("UNKNOWN-EVENT", who, e.type + " (first occurrence) " + short(e).take(160))
                else -> Log.log("unknown event", e.type)
            }
        }
    }

    // ---- reconcile (30 s): compare every unit with the REAL session and repair. This is what catches stalls, ghosts and missed events.
    private val reconciling = Mutex()
    suspend fun reconcile() {
        if (!reconciling.tryLock()) return
        try {
            for (u in live()) {
                if (u.done) continue
                if (Repo.isDone(u.file)) { Log.log(u.name, "reconcile: file is DONE"); scope.launch { handle(u, "reconcile") }; continue }
                if (u.lock.isLocked) continue
                val answered = try { Result.success(OpenCode.session(u.id)) } catch (e: Exception) { Result.failure(e) }
                if (answered.isFailure) continue                                             // opencode did not answer: decide nothing
                val s = answered.getOrNull()
                if (s == null) { retire(u, "reconcile: session gone", archive = false); continue }
                if (s.archived && !s.generating) { retire(u, "reconcile: session archived outside the daemon", archive = false); continue }
                if (s.generating != u.running) Log.log(u.name, "reconcile: running flag ${u.running} -> ${s.generating}")
                u.running = s.generating
                if (s.generating) {
                    val lastReal = maxOf(u.lastAct, Repo.mtime(u.file))                      // model activity, or the progress file written by a tool call
                    if (!Pool.paused && !u.stopping && now() - lastReal > Cfg.STALL_MS) {
                        val n = ++u.stallKicks; u.lastAct = now()
                        Log.note("STALL", u.name, "no model activity and no file write for ${Cfg.STALL_MS / 1000}s+ (kick $n)")
                        if (n >= 3) { rotate(u, "stalled $n times"); continue }
                        stop(u); scope.launch { handle(u, "stall") }                         // stop, wait until it really stopped, THEN send the continue
                    }
                } else if (!u.stopping && now() >= u.retryAt && now() - u.lastSend > Cfg.MIN_GAP_MS) scope.launch { handle(u, "reconcile: idle") }
            }
        } finally { reconciling.unlock() }
    }

    // ---- operator commands: every interruption is stop-then-send
    suspend fun nudge(name: String, text: String) {
        val m = Regex("^!(retry|restart)(?!\\w)\\s*").find(text); val cmd = m?.groupValues?.get(1); val body = if (m != null) text.removeRange(m.range) else text
        val targets = if (name == "ALL") live() else live().filter { it.name == name }
        if (targets.isEmpty()) {
            try { val hp = Repo.hintFile(name); hp.parentFile.mkdirs(); hp.appendText((if (hp.exists()) "\n" else "") + body); Log.note("NUDGE", name, "unit not running: saved as hint") } catch (e: Exception) { Log.log("nudge hint failed", e.toString().take(80)) }
            return
        }
        for (u in targets) {
            u.noProg = 0; u.intAuto = 0; u.stallKicks = 0; u.consFail = 0; u.retryAt = 0; u.lastSend = 0
            try {
                val s = OpenCode.session(u.id)
                if (s != null && s.generating) stop(u)                                      // a message to a generating session only queues: stop it first
                if (cmd == "restart" || (cmd == "retry" && body.isEmpty())) scope.launch { handle(u, "nudge $cmd") }
                else send(u, "ORCHESTRATOR NUDGE (read, apply, continue the unit): $body ${Cfg.RULES}")
                Log.note("NUDGE", u.name, "${cmd ?: "message"}: ${body.take(100)}")
            } catch (e: Exception) { Log.log(u.name, "nudge failed", e.toString().take(100)) }
        }
    }
    fun resetCounters() { for (u in live()) { u.noProg = 0; u.consFail = 0; u.retryAt = 0; u.stallKicks = 0 } }

    fun statusJson(): JsonArray = buildJsonArray {
        for (u in units.values) add(buildJsonObject {
            put("name", u.name); put("id", u.id); put("running", u.running); put("busy", u.lock.isLocked); put("done", u.done); put("stuck", false)
            put("idleS", (now() - u.lastEv) / 1000); put("actIdleS", (now() - maxOf(u.lastAct, Repo.mtime(u.file))) / 1000)
            put("noProg", u.noProg); put("stallKicks", u.stallKicks); put("consFail", u.consFail); put("ctxK", u.ctx / 1000); put("rotations", rotationCount(u.name))
        })
    }
}
