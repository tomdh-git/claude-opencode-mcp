package ocd

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import kotlin.system.exitProcess

/** ocd: the opencode unit daemon, as a typed Kotlin service.
 *  Layers (each calls only the one below):  Api (HTTP + file adapters) > Sched (policy) > Runner (unit state machine) > Pool (keys) > Store + OpenCode + Core (state, client, types).
 *  usage:  ocd                       live
 *          SHADOW=1 OCD_PORT=4778 ocd   observe-only: same events, decisions journaled as "would ...", no side effects */
fun main() { runBlocking { daemon() } }

suspend fun daemon(): Unit = coroutineScope {
    // single instance = the port (the bind fails when another copy runs)
    try { Api.serve() } catch (e: java.net.BindException) { println("ocd: port ${Cfg.PORT} busy, another ocd runs; exiting"); exitProcess(0) }
    if (!Cfg.SHADOW) File(Cfg.DIR, "ocd.lock").writeText(ProcessHandle.current().pid().toString())
    Thread.setDefaultUncaughtExceptionHandler { _, e -> Log.log("UNCAUGHT", e.stackTraceToString().take(400)) }

    Log.say("OCD started" + (if (Cfg.SHADOW) " (SHADOW: no side effects)" else "") + " port ${Cfg.PORT} maxrun ${Cfg.MAXRUN} (kotlin)")
    Pool.init()
    // adopt: live units from the store, plus what the TypeScript daemon / old keeper left in its files
    run {
        val seen = LinkedHashMap<String, Triple<String, String, String>>()
        for (r in Store.liveUnits()) seen[r.id] = Triple(r.id, r.name, r.file)
        runCatching { JSON.parseToJsonElement(File(Cfg.DIR, "keeper-units.json").readText()).jsonArray }.getOrNull()?.forEach { e ->
            val o = e.jsonObject; val id = o.str("id") ?: return@forEach
            if (id !in seen) seen[id] = Triple(id, o.str("name") ?: "", o.str("file") ?: "")
        }
        Runner.adopt(seen.values.toList())
        if (!Cfg.SHADOW) runCatching { JSON.parseToJsonElement(File(Cfg.DIR, "keeper-queue.json").readText()).jsonArray }.getOrNull()?.forEach { e ->
            val o = e.jsonObject; Store.enqueue(o.str("id") ?: return@forEach, o.str("name") ?: return@forEach, o.str("file") ?: "", o.str("promptFile") ?: "")
        }
    }
    for (q in Store.queue()) if (Runner.units.containsKey(q.id)) Store.dropName(q.name)   // queue rows for sessions that are already live units
    Sched.ready = true                                                                        // adoption is done: from here on the scheduler may start things

    Tasks.restore()
    launch(Dispatchers.Default) { Bus.flow.collect { e -> Runner.onBus(e); Sched.onBus(e); Api.onBus(e); Tasks.onBus(e) } }
    launch(Dispatchers.Default) { OpenCode.eventLoop({ Tasks.onEvent(it); Runner.onEvent(it) }, { shutdown -> Bus.emit(if (shutdown) BusEvent.OcShutdown else BusEvent.OcReconnected) }) }
    Sched.watchReviews()
    launch(Dispatchers.Default) {
        var tick = 0
        while (true) {
            delay(30_000)
            try {
                if (!Cfg.SHADOW && ++tick % 10 == 0) Sched.sweepTriage()
                Runner.reconcile(); Tasks.reconcile()
                if (Pool.auditDue) Pool.audit(if (Cfg.SHADOW) "periodic (shadow)" else "periodic")
                Sched.refill(); Sched.pump()
            } catch (e: Exception) { if (e is CancellationException) throw e; Log.log("tick error", e.toString().take(100)) }
        }
    }
    Runner.sweep("start"); Sched.refill(); Sched.pump()
    awaitCancellation()
}
