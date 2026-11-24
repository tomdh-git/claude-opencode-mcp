package ocd

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64

/** A failed opencode call. status 404 = the thing does not exist (a gone session is a normal answer, not a failure). */
class OcError(val status: Int, val tag: String?, message: String) : Exception(message) { val notFound get() = status == 404 }

/** Typed client for the local opencode service (plain REST under /api, Basic auth, SSE on /api/event; wire format recorded from the TypeScript SDK).
 *  The endpoint and password come from ~/.local/state/opencode/service.json and are re-read when the service restarts. */
object OpenCode {
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val regFile = File(Cfg.HOME, ".local/state/opencode/service.json")
    @Volatile private var base = ""
    @Volatile private var auth = ""

    private fun loadRegistration() {
        val o = JSON.parseToJsonElement(regFile.readText()).jsonObject
        base = o.str("url") ?: error("service.json has no url")
        auth = "Basic " + Base64.getEncoder().encodeToString(("opencode:" + (o.str("password") ?: "")).toByteArray())
    }

    private fun send(method: String, path: String, body: JsonElement? = null, timeoutS: Long = 60): JsonElement? {
        var lastError: Exception? = null
        for (attempt in 0..1) {
            if (base.isEmpty() || attempt == 1) loadRegistration()
            val rb = HttpRequest.newBuilder(URI(base + path)).timeout(Duration.ofSeconds(timeoutS)).header("authorization", auth)
            val req = if (body != null) rb.header("content-type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body.toString())).build()
                      else rb.method(method, HttpRequest.BodyPublishers.noBody()).build()
            val res = try { http.send(req, HttpResponse.BodyHandlers.ofString()) } catch (e: java.io.IOException) { lastError = e; continue }
            if (res.statusCode() == 401 && attempt == 0) continue      // the password changed: the service restarted
            if (res.statusCode() >= 400) {
                val e = runCatching { JSON.parseToJsonElement(res.body()).jsonObject }.getOrNull()
                throw OcError(res.statusCode(), e?.str("_tag"), e?.str("message") ?: res.body().take(200))
            }
            return if (res.body().isBlank()) null else JSON.parseToJsonElement(res.body())
        }
        throw lastError ?: IllegalStateException("opencode request failed: $method $path")
    }
    private suspend fun call(method: String, path: String, body: JsonElement? = null, timeoutS: Long = 60): JsonElement? = withContext(Dispatchers.IO) { send(method, path, body, timeoutS) }
    private fun data(e: JsonElement?): JsonElement? = (e as? JsonObject)?.get("data")
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /** every MUTATING call goes through here: in shadow mode it only journals what it would do */
    suspend fun <T> act(what: String, f: suspend () -> T): T? {
        if (Cfg.SHADOW) { Store.journal("would", "", what); return null }
        return f()
    }

    // ---- sessions
    suspend fun session(id: String): Session? = try { data(call("GET", "/api/session/$id"))?.obj()?.let(Session::parse) } catch (e: OcError) { if (e.notFound) null else throw e }
    suspend fun sessions(): List<Session> = (data(call("GET", "/api/session")) as? JsonArray)?.mapNotNull { it.obj()?.let(Session::parse) } ?: emptyList()
    suspend fun context(id: String): List<Message> {
        val items = when (val d = data(call("GET", "/api/session/$id/context"))) { is JsonArray -> d.toList(); is JsonObject -> d.values.toList(); else -> emptyList() }
        return items.mapNotNull { it.obj()?.let(Message::parse) }
    }
    suspend fun create(title: String, m: ModelRef = Cfg.MODEL): String {
        val body = buildJsonObject {
            put("title", title); put("agent", "general")
            put("model", buildJsonObject { put("id", m.id); put("providerID", m.providerID); put("variant", "default") })
            put("location", buildJsonObject { put("directory", Cfg.REPO.path.replace('\\', '/')) })
        }
        val id = data(call("POST", "/api/session", body))?.obj()?.str("id") ?: error("create returned no session id")
        switchModel(id, m); return id
    }
    suspend fun switchModel(id: String, m: ModelRef = Cfg.MODEL) { call("POST", "/api/session/$id/model", buildJsonObject { put("model", buildJsonObject { put("id", m.id); put("providerID", m.providerID) }) }) }
    suspend fun prompt(id: String, text: String) { call("POST", "/api/session/$id/prompt", buildJsonObject { put("text", text) }) }
    suspend fun interrupt(id: String): Boolean = call("POST", "/api/session/$id/interrupt")?.obj()?.get("interrupted")?.jsonPrimitive?.booleanOrNull ?: false
    suspend fun setArchived(id: String, archived: Boolean) { call("PATCH", "/api/session/$id", buildJsonObject { put("archived", archived) }) }

    // ---- forms and permissions
    suspend fun forms(sessionId: String): List<Pair<String, String>> = (data(call("GET", "/api/session/$sessionId/form")) as? JsonArray)?.mapNotNull { f -> f.obj()?.let { o -> o.str("id")?.let { it to (o.str("title") ?: "") } } } ?: emptyList()
    suspend fun cancelForm(sessionId: String, formId: String, message: String) { call("DELETE", "/api/session/$sessionId/form/${enc(formId)}?message=${enc(message)}") }
    suspend fun replyPermission(sessionId: String, requestId: String, decision: String, message: String) { call("POST", "/api/session/$sessionId/permission/${enc(requestId)}/reply", buildJsonObject { put("decision", decision); put("message", message) }) }

    // ---- credentials (the Kilo key the service really uses)
    data class Credential(val id: String, val integrationID: String, val label: String, val active: Boolean, val key: String?)
    suspend fun credentials(): List<Credential> = (data(call("GET", "/api/credential")) as? JsonArray)?.mapNotNull { c ->
        c.obj()?.let { o -> o.str("id")?.let { id -> Credential(id, o.str("integrationID") ?: "", o.str("label") ?: "", o["active"]?.jsonPrimitive?.booleanOrNull ?: false, o.sub("value")?.str("key")) } }
    } ?: emptyList()
    suspend fun activateCredential(id: String) { call("POST", "/api/credential/${enc(id)}/activate") }
    suspend fun createCredential(integrationId: String, label: String, key: String) {
        call("POST", "/api/credential", buildJsonObject { put("integrationID", integrationId); put("label", label); put("value", buildJsonObject { put("type", "key"); put("key", key) }); put("activate", true) })
    }

    // ---- the event stream, resubscribed forever
    /** Reads /api/event and hands every event to `handler` (one at a time, in order). `onReconnect(shutdown)` fires when the stream ended. Never returns. */
    suspend fun eventLoop(handler: suspend (OcEvent) -> Unit, onReconnect: suspend (shutdown: Boolean) -> Unit): Nothing = coroutineScope {
        var quick = 0
        while (true) {
            val t0 = System.currentTimeMillis(); var shutdown = false
            val ch = Channel<OcEvent>(Channel.UNLIMITED)
            val reader = launch(Dispatchers.IO) {
                try {
                    if (base.isEmpty()) loadRegistration()
                    val req = HttpRequest.newBuilder(URI("$base/api/event")).header("authorization", auth).header("accept", "text/event-stream").GET().build()
                    val res = http.send(req, HttpResponse.BodyHandlers.ofLines())
                    if (res.statusCode() == 401) loadRegistration()
                    res.body().use { lines ->
                        for (l in lines.iterator()) {
                            if (!l.startsWith("data:")) continue
                            val o = runCatching { JSON.parseToJsonElement(l.substring(5).trim()).jsonObject }.getOrNull() ?: continue
                            ch.trySend(OcEvent.parse(o))
                        }
                    }
                } catch (e: Exception) {
                    if (e !is CancellationException) { Log.log("event stream error", e.toString().take(140)); if (e is java.io.IOException) runCatching { loadRegistration() } }
                } finally { ch.close() }
            }
            for (e in ch) {
                try { handler(e) } catch (x: Exception) { if (x is CancellationException) throw x; Log.log("event handler error", e.type, x.toString().take(200)) }
                if (e is OcEvent.Shutdown) { shutdown = true; Log.say("opencode server shutting down: resubscribing in 5 s"); reader.cancel(); delay(5000); break }
            }
            reader.cancel()
            if (System.currentTimeMillis() - t0 < 1000 && ++quick > 5) { Log.say("OCD event stream keeps closing, exiting"); System.exit(3) }
            if (System.currentTimeMillis() - t0 > 10000) quick = 0
            Log.log("event stream ended, resubscribing"); onReconnect(shutdown); delay(3000)
        }
        @Suppress("UNREACHABLE_CODE") error("unreachable")
    }
}
