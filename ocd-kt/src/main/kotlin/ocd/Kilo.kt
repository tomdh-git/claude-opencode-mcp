package ocd

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.json.*
import java.io.File

/** The internal bus: layers announce typed events, other layers react. Nothing polls. */
object Bus {
    val flow = MutableSharedFlow<BusEvent>(extraBufferCapacity = 256)
    fun emit(e: BusEvent) { flow.tryEmit(e) }
}

/** One managed Kilo account. `raw` is the JSON as stored: we only touch the fields we own, so fields written by other tools survive. */
data class KiloAccount(val id: String, val label: String, val enabled: Boolean, val apiKey: String?, val raw: JsonObject)

/** The Kilo multi-account store shared with the MCP bridge (accounts.json, state.json) plus the auth.json the opencode CLI reads. */
object Kilo {
    private val dir = File(System.getenv("OCMCP_KILO_STORE_DIR") ?: File(Cfg.HOME, ".config/opencode/kilo-multi-account").path)
    private val accountsFile = File(System.getenv("OCMCP_KILO_ACCOUNTS_PATH") ?: File(dir, "accounts.json").path)
    private val stateFile = File(System.getenv("OCMCP_KILO_STATE_PATH") ?: File(dir, "state.json").path)
    private val authFile = File(System.getenv("OCMCP_AUTH_JSON_PATH") ?: File(Cfg.HOME, ".local/share/opencode/auth.json").path)

    private fun readObj(f: File, fallback: JsonObject): JsonObject = try { JSON.parseToJsonElement(f.readText()).jsonObject } catch (_: Exception) { fallback }
    private fun writeObj(f: File, o: JsonObject) { f.parentFile.mkdirs(); val tmp = File(f.path + ".tmp-ocd"); tmp.writeText(o.toString()); tmp.renameTo(f).also { if (!it) { f.delete(); tmp.renameTo(f) } } }

    class State(val accounts: List<KiloAccount>, val activeId: String?, val rawAccountsFile: JsonObject, val rawState: JsonObject)
    fun load(): State {
        val af = readObj(accountsFile, buildJsonObject { put("version", 1); put("accounts", JsonArray(emptyList())) })
        val st = readObj(stateFile, buildJsonObject { put("version", 1) })
        val accounts = (af.arr("accounts") ?: JsonArray(emptyList())).mapNotNull { e ->
            val o = e.obj() ?: return@mapNotNull null
            val cred = o.sub("credentials")
            KiloAccount(o.str("id") ?: return@mapNotNull null, o.str("label") ?: "", o["enabled"]?.jsonPrimitive?.booleanOrNull ?: true, if (cred?.str("type") == "api") cred.str("key") else null, o)
        }
        return State(accounts, st.str("activeAccountId"), af, st)
    }

    /** make `id` the active account: state.json, the account's bookkeeping fields, auth.json, and the credential the RUNNING service uses */
    suspend fun switchTo(id: String) {
        val s = load(); val target = s.accounts.find { it.id == id } ?: error("Kilo account not found: $id")
        require(target.enabled) { "Kilo account is disabled: $id" }
        val now = System.currentTimeMillis()
        val accounts = (s.rawAccountsFile.arr("accounts") ?: JsonArray(emptyList())).map { e ->
            val o = e.jsonObject
            if (o.str("id") != id) e else JsonObject(o.filterKeys { it != "cooldownUntil" && it != "lastError" } + mapOf("lastUsedAt" to JsonPrimitive(now), "updatedAt" to JsonPrimitive(now)))
        }
        writeObj(accountsFile, JsonObject(s.rawAccountsFile + mapOf("accounts" to JsonArray(accounts))))
        writeObj(stateFile, JsonObject(s.rawState + mapOf("activeAccountId" to JsonPrimitive(id))))
        syncAuthJson(target)
        activateInService(target)
    }

    private fun syncAuthJson(a: KiloAccount) {
        val cred = a.raw.sub("credentials") ?: return
        val payload = if (cred.str("type") == "api") buildJsonObject { put("type", "api"); put("key", cred.str("key") ?: "") } else cred
        val current = readObj(authFile, JsonObject(emptyMap()))
        writeObj(authFile, JsonObject(current + (Cfg.KILO_PROVIDER to payload)))
    }

    /** opencode keeps its own credential store while running and ignores auth.json, so find the credential holding this key and activate it (create it when missing) */
    private suspend fun activateInService(a: KiloAccount): Boolean {
        val key = a.apiKey ?: return false
        return try {
            val hit = OpenCode.credentials().find { it.integrationID == Cfg.KILO_PROVIDER && it.key == key }
            if (hit == null) OpenCode.createCredential(Cfg.KILO_PROVIDER, a.label.ifEmpty { "Kilo (bridge)" }, key) else if (!hit.active) OpenCode.activateCredential(hit.id)
            true
        } catch (e: Exception) { Log.log("activateInService failed", e.toString().take(100)); false }
    }
}
