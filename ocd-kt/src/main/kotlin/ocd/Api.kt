package ocd

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.*
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue

/** L5 API + compat adapters. The HTTP API is the real interface; the file adapters exist so the existing orchestrator tools keep working unchanged:
 *    nudge-inbox/<unit>.txt (tools/nudge.py)   queue-drop.txt   keeper.kick / keeper.sweep / keeper.rotate (touch)
 *  and derived mirrors for readers of the old files: keeper-units.json, keeper-queue.json, watchdog-status.json (written atomically, never read back as state). */
object Api {
    private val started = System.currentTimeMillis()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sse = java.util.concurrent.CopyOnWriteArrayList<LinkedBlockingQueue<String>>()

    fun snapshot(): JsonObject = buildJsonObject {
        val us = Runner.statusJson()
        put("ok", true); put("pid", ProcessHandle.current().pid()); put("uptimeS", (System.currentTimeMillis() - started) / 1000); put("shadow", Cfg.SHADOW); put("maxrun", Cfg.MAXRUN)
        put("running", Runner.live().size)                                   // slots in use (live units)
        put("generating", us.count { it.jsonObject["running"]?.jsonPrimitive?.boolean == true })   // units generating right now
        put("units", us); put("queue", buildJsonArray { Store.queue().forEach { add(it.name) } }); put("keys", Pool.summary())
        put("journal", journalJson(15))
    }
    private fun journalJson(n: Int) = buildJsonArray { Store.recentJournal(n).forEach { add(buildJsonObject { put("seq", it.seq); put("ts", it.ts); put("kind", it.kind); put("unit", it.unit); put("detail", it.detail) }) } }

    /** one entry point for every operator command, whatever transport it arrived on */
    suspend fun command(unit: String, text: String): JsonObject {
        if (Regex("^!drop(?!\\w)").containsMatchIn(text)) { Sched.drop(unit); return buildJsonObject { put("ok", true); put("dropped", unit) } }
        Runner.nudge(unit, text); return buildJsonObject { put("ok", true) }
    }

    private fun HttpExchange.json(o: JsonElement, status: Int = 200) { val b = o.toString().toByteArray(); responseHeaders.add("content-type", "application/json"); sendResponseHeaders(status, b.size.toLong()); responseBody.use { it.write(b) } }
    private fun HttpExchange.text(t: String, status: Int = 200) { val b = t.toByteArray(); sendResponseHeaders(status, b.size.toLong()); responseBody.use { it.write(b) } }

    private fun route(x: HttpExchange) {
        try {
            val path = x.requestURI.path; val post = x.requestMethod == "POST"
            val q = (x.requestURI.query ?: "").split("&").filter { "=" in it }.associate { it.substringBefore("=") to it.substringAfter("=") }
            when {
                path == "/health" -> x.json(buildJsonObject { put("ok", true); put("pid", ProcessHandle.current().pid()) })
                path == "/status" -> x.json(snapshot())
                path == "/journal" -> x.json(journalJson(q["n"]?.toIntOrNull() ?: 100))
                path == "/digest" -> { val f = File(Cfg.PROG, "DIGEST.md"); if (f.exists()) x.text(f.readText()) else x.json(buildJsonObject { put("error", "no digest") }, 404) }
                post && path == "/nudge" -> {
                    val b = runCatching { JSON.parseToJsonElement(x.requestBody.readBytes().toString(Charsets.UTF_8)).jsonObject }.getOrNull()
                    val unit = b?.str("unit"); val msg = b?.str("message")
                    if (unit == null || msg == null) x.json(buildJsonObject { put("error", "unit and message required") }, 400) else x.json(runBlocking { command(unit, msg) })
                }
                post && path == "/kick" -> { Runner.resetCounters(); scope.launch { Runner.reconcile(); Sched.pump() }; x.json(buildJsonObject { put("ok", true) }) }
                post && path == "/rotate" -> { scope.launch { Pool.onQuota("operator request", true) }; x.json(buildJsonObject { put("ok", true) }) }
                post && path == "/review" -> { Bus.emit(BusEvent.ReviewRecorded); x.json(buildJsonObject { put("ok", true) }) }
                path == "/events" -> {                                          // SSE of the bus
                    x.responseHeaders.add("content-type", "text/event-stream"); x.sendResponseHeaders(200, 0)
                    val qu = LinkedBlockingQueue<String>(); sse.add(qu)
                    try { x.responseBody.use { o -> while (true) { val m = qu.take(); o.write(m.toByteArray()); o.flush() } } } finally { sse.remove(qu) }
                }
                else -> x.json(buildJsonObject { put("error", "not found") }, 404)
            }
        } catch (e: Exception) { runCatching { x.json(buildJsonObject { put("error", e.toString().take(200)) }, 500) } } finally { runCatching { x.close() } }
    }

    // ---- derived mirrors (debounced: one write per burst)
    @Volatile private var mirrorPending = false
    fun mirrors() {
        if (mirrorPending) return; mirrorPending = true
        scope.launch { delay(300); mirrorPending = false; writeMirrors() }
    }
    private fun atomic(f: File, text: String) { val t = File(f.path + ".tmp"); t.writeText(text); Files.move(t.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING) }
    private fun writeMirrors() {
        try {
            atomic(File(Cfg.DIR, "keeper-units.json"), buildJsonArray { Runner.live().forEach { u -> add(buildJsonObject { put("id", u.id); put("name", u.name); put("file", u.file.path.replace('\\', '/')) }) } }.toString())
            atomic(File(Cfg.DIR, "keeper-queue.json"), buildJsonArray { Store.queue().forEach { r -> add(buildJsonObject { put("id", r.id); put("name", r.name); put("file", r.file); put("promptFile", r.promptFile) }) } }.toString())
            File(Cfg.DIR, "watchdog-status.json").writeText(buildJsonObject { put("at", java.time.Instant.now().toString()); put("running", Runner.live().size); put("target", Cfg.MAXRUN); put("cores", Runner.live().size); put("quota", 0); put("zeroTps", 0); put("by", "ocd-kt") }.toString())
        } catch (e: Exception) { Log.log("mirror write failed", e.toString().take(80)) }
    }

    // ---- file adapters
    private suspend fun nudgeFiles() {
        val dir = File(Cfg.DIR, "nudge-inbox"); val fl = dir.listFiles { f -> f.name.endsWith(".txt") } ?: return
        for (f in fl) {
            val t = try { f.readText().trim().also { f.delete() } } catch (_: Exception) { continue }
            if (t.isEmpty()) continue
            command(f.name.replace(Regex("(\\.\\d+)?\\.txt$"), ""), t)
        }
    }
    fun onBus(e: BusEvent) {
        if (e is BusEvent.UnitStarted || e is BusEvent.UnitFinished || e == BusEvent.QueueChanged || e is BusEvent.KeyRotated) mirrors()
        val name = when (e) { is BusEvent.UnitFinished -> "unit.finished"; is BusEvent.UnitStarted -> "unit.started"; BusEvent.QueueChanged -> "queue.changed"; is BusEvent.KeyRotated -> "key.rotated"; BusEvent.KeysExhausted -> "keys.exhausted"; BusEvent.KeysRecovered -> "keys.recovered"; else -> null } ?: return
        val m = "event: $name\ndata: ${e.toString().replace("\n", " ")}\n\n"; sse.forEach { it.offer(m) }
    }

    fun serve() {
        val srv = HttpServer.create(InetSocketAddress("127.0.0.1", Cfg.PORT), 0)    // bind failure = another ocd runs (single instance = the port)
        srv.executor = Executors.newCachedThreadPool { r -> Thread(r).also { it.isDaemon = true } }
        srv.createContext("/") { route(it) }; srv.start()
        if (Cfg.SHADOW) { Log.log("shadow: HTTP only, no file adapters, no mirrors"); return }
        File(Cfg.DIR, "nudge-inbox").mkdirs()
        scope.launch { nudgeFiles() }
        scope.launch {
            try {
                val ws = FileSystems.getDefault().newWatchService()
                File(Cfg.DIR, "nudge-inbox").toPath().register(ws, StandardWatchEventKinds.ENTRY_CREATE, StandardWatchEventKinds.ENTRY_MODIFY)
                Cfg.DIR.toPath().register(ws, StandardWatchEventKinds.ENTRY_CREATE, StandardWatchEventKinds.ENTRY_MODIFY)
                while (true) {
                    val k = ws.take()
                    for (ev in k.pollEvents()) {
                        val n = ev.context().toString()
                        when {
                            k.watchable().toString().endsWith("nudge-inbox") -> if (n.endsWith(".txt")) nudgeFiles()
                            n == "queue-drop.txt" -> runCatching { val f = File(Cfg.DIR, n); val t = f.readLines().map { it.trim() }.filter { it.isNotEmpty() }; if (t.isNotEmpty()) { f.writeText(""); t.forEach { Sched.drop(it) } } }
                            n == "keeper.kick" -> { Runner.resetCounters(); Runner.reconcile(); Sched.pump() }
                            n == "keeper.sweep" -> { Runner.sweep("sweep"); Sched.pump() }
                            n == "keeper.rotate" -> Pool.onQuota("rotate requested", true)
                        }
                    }
                    k.reset()
                }
            } catch (e: Exception) { Log.log("file adapter failed", e.toString().take(100)) }
        }
        mirrors()
    }
}
