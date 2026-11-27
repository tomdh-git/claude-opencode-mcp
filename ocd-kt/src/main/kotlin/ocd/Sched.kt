package ocd

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import java.io.File
import java.nio.file.*

/** L3 scheduler / policy: which item next, how many run, when the queue is topped up. Wakes on bus events, never on file polling.
 *  The item-selection POLICY (tiers, retry backoff, needs-hint parking, review gate) stays in tools/nextitems.py + tools/mkeasy.py on purpose: they are the shared source of truth
 *  with the orchestrator's other tools; this layer only calls them. Everything stateful (queue, uniqueness, pop) is in the Store. */
object Sched {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    /** nothing is scheduled until the daemon has adopted the units that are already running (a pump before adoption started every queued entry a second time) */
    @Volatile var ready = false
    private val pumpLock = Mutex(); private val refillLock = Mutex()
    @Volatile private var pumpAgain = false; @Volatile private var refillAgain = false

    private fun archiveLater(id: String) { scope.launch { runCatching { OpenCode.act("archive $id") { OpenCode.setArchived(id, true) } } } }

    /** move queue heads into free slots */
    suspend fun pump() {
        if (Cfg.SHADOW || !ready) return
        if (!pumpLock.tryLock()) { pumpAgain = true; return }
        try {
            if (Pool.paused) return
            while (Runner.live().size < Cfg.MAXRUN) {
                val e = Store.pop() ?: break
                when {
                    // the same SESSION is already a live unit (adopted from another controller): never start it twice (that re-prompts it and archives its running output file)
                    Runner.units.containsKey(e.id) -> { Log.log("queue entry dropped, session already a live unit:", e.name); continue }
                    e.name !in Repo.openItems() -> { Log.log("queue entry dropped, checklist item already ticked:", e.name); archiveLater(e.id); continue }
                    Runner.live().any { it.name == e.name && it.id != e.id } -> { Log.log("queue entry dropped, unit already running:", e.name); archiveLater(e.id); continue }
                }
                Runner.start(e)
                Log.say("STARTED ${e.name} from queue (${Store.queue().size} left)"); Bus.emit(BusEvent.QueueChanged)
            }
        } catch (e: Exception) { if (e is CancellationException) throw e; Log.log("pump error", e.toString().take(120)) }
        finally { pumpLock.unlock(); if (pumpAgain) { pumpAgain = false; scope.launch { pump() } } }
    }
    fun drop(name: String) { for (r in Store.dropName(name)) { Log.note("QUEUE", r.name, "dropped"); Bus.emit(BusEvent.QueueChanged); archiveLater(r.id) } }

    /** keep TOPUP pre-created units queued */
    suspend fun refill() {
        if (Cfg.SHADOW || !ready) return
        if (!refillLock.tryLock()) { refillAgain = true; return }
        try {
            val open = Repo.openItems()
            val pending = Store.queue().filter { it.name in open }.map { it.name }.toMutableSet()
            val need = Cfg.TOPUP - pending.size; if (need <= 0) return
            val live = mutableSetOf<String>()
            try { for (x in OpenCode.sessions()) if (!x.archived && (x.outcome == "running" || x.generating || (x.outcome == null && System.currentTimeMillis() - x.updated < 600_000))) live.add(x.title) }
            catch (e: Exception) { Log.log("session list failed, not refilling", e.toString().take(100)); return }
            Runner.live().forEach { live.add(it.name) }
            val ids = withContext(Dispatchers.IO) { py("tools/nextitems.py", (need + 8).toString()).first }.lines().map { it.trim() }.filter { it.isNotEmpty() }
            var made = 0
            for (id in ids) {
                val name = "U-E$id"; if (made >= need) break
                if (name in pending || name in live) continue
                val promptFile = File(Cfg.PROG, "_p_$name.txt"); withContext(Dispatchers.IO) {
                    py("tools/mkeasy.py", id)
                    // single (whole-function) items get a static pack computed by programs; the unit reads it first (tools/ctx/pack.py)
                    if (Regex("^X[0-9][.][0-9a-f]+$").matches(id) && promptFile.exists()) {
                        val rva = id.substringAfter('.')
                        py("tools/ctx/pack.py", "build", "0x$rva")
                        // one self-contained prompt (pack + data + scaffold inlined); when it is rewritten the old "read the pack" line below is not needed
                        val rewritten = py("tools/ctx/mkprompt.py", id).first.contains("prompt rewritten")
                        if (!rewritten && File(Cfg.REPO, "docs/progress/pack/$rva.md").exists()) promptFile.appendText(System.lineSeparator() + "PACK: docs/progress/pack/$rva.md was computed by programs from the exe (listing, callers, callee status, strings, field accesses, closest finished lift). Read it FIRST and do not recompute what it states; think only about its [open] decisions. Finish with python tools/ctx/gate.py 0x$rva (one line) before writing CLOSES? YES. Keep reply text to 2 short lines between tool calls (no analysis in text); a small function must take under 12 turns. See the Speed rules in docs/OPENCODE_BRIEF.md." + System.lineSeparator())
                    }
                }
                if (!promptFile.exists()) { Log.log("no prompt for", id); continue }
                val sid = OpenCode.create(name, Cfg.modelFor(name)); Store.journal("ARM", name, Cfg.armOf(name) + " " + Cfg.modelFor(name).id + "/" + Cfg.modelFor(name).variant)
                if (Store.enqueue(sid, name, File(Cfg.PROG, "oc_$name.md").path, promptFile.path)) { pending.add(name); made++; Log.say(java.time.Instant.now().toString(), "queued", name, sid); Bus.emit(BusEvent.QueueChanged) }
                else archiveLater(sid)   // the store refused a duplicate: never keep the orphan session
            }
        } catch (e: Exception) { if (e is CancellationException) throw e; Log.log("refill error", e.toString().take(200)) }
        finally { refillLock.unlock(); if (refillAgain) { refillAgain = false; scope.launch { refill() } } else scope.launch { pump() } }
    }

    fun onBus(e: BusEvent) {
        when (e) {
            is BusEvent.UnitFinished -> scope.launch {
                // programs decide close / retry / resolve from the gate (tools/ctx/finish.py); a unit that left a placeholder `CLOSES? NO` with a passing gate is closed, a failing gate writes its errors into a hint
                val id = e.name.removePrefix("U-E")
                if (Regex("^X[0-9][.][0-9a-f]+$").matches(id)) withContext(Dispatchers.IO) { runCatching { Log.log("finish", id, py("tools/ctx/finish.py", id).first.trim().take(160)) } }
                pump(); refill()
            }
            is BusEvent.UnitStarted -> scope.launch { refill() }      // NOT QueueChanged: refill/pump emit that one (mirrors listen to it); listening to it looped forever
            BusEvent.ReviewRecorded -> scope.launch { refill() }
            BusEvent.KeysRecovered, is BusEvent.KeyRotated -> scope.launch { pump() }
            else -> {}
        }
    }
    /** the orchestrator's reviews (checklist_status.py / triage.py append to reviewed.txt) make items eligible again */
    fun watchReviews() {
        scope.launch(Dispatchers.IO) {
            try {
                val ws = FileSystems.getDefault().newWatchService()
                Cfg.PROG.toPath().register(ws, StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_CREATE)
                File(Cfg.PROG, "hints").takeIf { it.isDirectory }?.toPath()?.register(ws, StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_CREATE)
                while (true) { val k = ws.take(); for (ev in k.pollEvents()) { val n = ev.context().toString(); if (n == "reviewed.txt" || n == "needs_hint.txt" || n.endsWith(".txt") && k.watchable().toString().endsWith("hints")) Bus.emit(BusEvent.ReviewRecorded) }; k.reset() }
            } catch (e: Exception) { Log.log("watchReviews failed", e.toString().take(100)) }
        }
    }
    /** finished outputs nobody triaged would block their item as "awaiting review" and starve the slots: triage them (zero model; verify-kind ones stay for the orchestrator) */
    fun sweepTriage() { if (!Cfg.SHADOW) scope.launch(Dispatchers.IO) { py("tools/triage.py", "--sweep"); Bus.emit(BusEvent.ReviewRecorded) } }
}
