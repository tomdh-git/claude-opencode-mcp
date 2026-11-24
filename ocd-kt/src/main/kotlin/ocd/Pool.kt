package ocd

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/** Provider key pool: the single owner of Kilo key state. Knows nothing about units; talks to the rest through the Bus.
 *  Health = a REAL tiny chat request per key (2xx only). Rotation = probe the keys after the active one, activate the first that answers; when none does, `paused` until a re-probe succeeds. */
object Pool {
    private const val URL = "https://api.kilo.ai/api/gateway/chat/completions"
    private const val RETRY_MS = 90_000L
    private const val AUDIT_MS = 15 * 60_000L
    private const val DEAD_MS = 120_000L
    private class Key(val id: String, val label: String, val key: String, var coolUntil: Long = 0, var fails: Int = 0)
    private val keys = LinkedHashMap<String, Key>()
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val picking = Mutex()
    @Volatile var paused = false; private set
    @Volatile private var switchedAt = 0L
    @Volatile private var lastAudit = 0L
    private var wake: Job? = null

    private fun refresh(): Kilo.State {
        val st = Kilo.load()
        for (a in st.accounts) if (a.apiKey != null && a.enabled && a.label !in keys) keys[a.label] = Key(a.id, a.label, a.apiKey)
        return st
    }
    private suspend fun probe(k: Key): Int = withContext(Dispatchers.IO) {
        val status = try {
            val body = buildJsonObject { put("model", Cfg.MODEL.id); put("messages", buildJsonArray { add(buildJsonObject { put("role", "user"); put("content", "hi") }) }); put("max_tokens", 3) }
            val req = HttpRequest.newBuilder(URI(URL)).timeout(Duration.ofSeconds(25)).header("authorization", "Bearer " + k.key).header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString())).build()
            http.send(req, HttpResponse.BodyHandlers.ofString()).statusCode()
        } catch (_: Exception) { 0 }
        Store.saveKey(k.label, k.coolUntil, k.fails, status); status
    }
    private fun healthy(status: Int) = status in 200..299

    /** probe the keys after `after` in order and activate the first that answers 2xx; false (and paused) when none does */
    suspend fun pick(after: String? = null): Boolean {
        if (!picking.tryLock()) return !paused
        try {
            refresh()
            val all = keys.values.toList(); val i = all.indexOfFirst { it.label == after }
            for (k in all.drop(i + 1) + all.take(i + 1)) {
                if (healthy(probe(k))) {
                    k.fails = 0; k.coolUntil = 0
                    if (!Cfg.SHADOW) Kilo.switchTo(k.id)
                    switchedAt = System.currentTimeMillis(); val was = paused; paused = false
                    Log.say("KEY active ${k.label} (probe ok)"); Bus.emit(BusEvent.KeyRotated(k.label)); if (was) Bus.emit(BusEvent.KeysRecovered)
                    return true
                }
                k.fails++; k.coolUntil = System.currentTimeMillis() + DEAD_MS
            }
            paused = true; wake?.cancel(); wake = scope.launch { delay(RETRY_MS); wake = null; pick() }
            Log.say("ALL KEYS COOLING: every key failed a real probe, units paused, re-probing every ${RETRY_MS / 1000} s")
            Bus.emit(BusEvent.KeysExhausted); return false
        } finally { picking.unlock() }
    }

    /** a unit hit a quota/rate error (or an operator asked): rotate off the active key. Debounced: failures within 8 s of a switch belong to the old key. */
    suspend fun onQuota(why: String, force: Boolean = false) {
        if (File(Cfg.DIR, "norotate").exists()) return
        if (!force && System.currentTimeMillis() - switchedAt < 8000) return
        val st = refresh(); val cur = st.accounts.find { it.id == st.activeId }?.label ?: return
        Log.say("KEY $cur hit the limit ($why): probe for a working key (running units are not interrupted)")
        pick(cur)
    }

    /** audit every key with a real request; rotate when the ACTIVE one is bad. Writes watchdog-keys.json (read by the python tools). */
    suspend fun audit(reason: String) {
        lastAudit = System.currentTimeMillis(); val st = refresh()
        val res = st.accounts.filter { it.apiKey != null && it.enabled }.mapNotNull { a -> keys[a.label]?.let { k -> val s = probe(k); Triple(a, s, healthy(s)) } }
        val summary = res.joinToString(" ") { (a, s, ok) -> a.label + if (ok) ":ok" else ":$s" }
        Log.log("key audit ($reason): $summary")
        try {
            File(Cfg.DIR, "watchdog-keys.json").writeText(buildJsonObject {
                put("at", java.time.Instant.now().toString()); put("reason", reason); put("activeId", st.activeId)
                put("results", buildJsonArray { res.forEach { (a, s, ok) -> add(buildJsonObject { put("label", a.label); put("id", a.id); put("status", s); put("ok", ok) }) } })
            }.toString())
        } catch (_: Exception) {}
        if (res.none { it.third }) { Log.say("WATCHDOG ALL KEYS DOWN $summary"); return }
        val active = res.find { it.first.id == st.activeId }
        if (active != null && !active.third && !paused) onQuota("audit: active key failed", true)
    }
    val auditDue get() = System.currentTimeMillis() - lastAudit > AUDIT_MS
    suspend fun init() { refresh(); pick() }
    fun summary(): JsonObject = buildJsonObject {
        put("paused", paused)
        put("keys", buildJsonArray { Store.keys().forEach { k -> add(buildJsonObject { put("label", k.label); put("cool_until", k.coolUntil); put("fails", k.fails); put("last_status", k.lastStatus); put("last_probe", k.lastProbe) }) } })
    }
}
