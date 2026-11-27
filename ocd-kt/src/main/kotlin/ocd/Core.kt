package ocd

import kotlinx.serialization.json.*
import java.io.File
import java.time.Instant

/** Every setting in one typed place. Environment variables override the defaults (same names as the TypeScript daemon). */
object Cfg {
    private fun env(k: String) = System.getenv(k)
    private fun envLong(k: String, d: Long) = env(k)?.toLongOrNull() ?: d

    val SHADOW: Boolean = env("SHADOW") != null            // observe + journal only, never act
    val DIR: File = File(env("OCD_DIR") ?: "C:/Users/Atomi/opencode-mcp-bridge")
    val REPO: File = File(env("OCD_REPO") ?: "C:/Users/Atomi/Desktop/BlueySenseV2")
    val PROG: File = File(REPO, "docs/progress")
    val PORT: Int = envLong("OCD_PORT", 4777).toInt()
    val MAXRUN: Int = envLong("MAXRUN", 4).toInt()
    val TOPUP: Int = envLong("TOPUP", 3).toInt()
    val STALL_MS: Long = envLong("STALL_S", 240) * 1000
    val MIN_GAP_MS: Long = envLong("MIN_GAP_S", 20) * 1000
    val CTX_MAX: Long = envLong("CTX_MAX", 150_000)
    val MAX_ROT: Int = envLong("MAX_ROT", 3).toInt()
    const val NOPROG_MAX = 6
    const val FAIL_ROTATE = 6
    val MODEL = ModelRef("kilo-auto/free", "kilo")
    /** A/B arm "fast": whole-function items (singles) whose name hashes below ARM_FAST_PCT run on a model with reasoning switched off (variant none). kilo-auto/free currently routes to nvidia/nemotron-3.5-super-vl:free, which spends ~99% of its tokens reasoning. 0 = off. */
    val ARM_FAST_PCT: Int = envLong("ARM_FAST_PCT", 0).toInt()
    val FAST_MODEL = ModelRef("nvidia/nemotron-3.5-super-vl:free", "kilo", "none")
    private val SINGLE = Regex("^U-EX[0-9][.][0-9a-f]+$")
    /** A/B arm "zen": OpenCode Zen free model (no key of ours; provider id "opencode"); a share of singles, taken from the low end of the hash range before the fast arm. 0 = off. */
    val ARM_ZEN_PCT: Int = envLong("ARM_ZEN_PCT", 0).toInt()
    val ZEN_MODEL = ModelRef("deepseek-v4.1-flash-free", "opencode")
    fun armOf(name: String): String { if (!SINGLE.matches(name)) return "control"; val h = Math.floorMod(name.hashCode(), 100); return if (h < ARM_ZEN_PCT) "zen" else if (ARM_FAST_PCT > 0 && h < ARM_ZEN_PCT + ARM_FAST_PCT) "fast" else "control" }
    fun modelFor(name: String): ModelRef = when (armOf(name)) { "zen" -> ZEN_MODEL; "fast" -> FAST_MODEL; else -> MODEL }
    const val KILO_PROVIDER = "kilo"
    val HOME: File = File(System.getProperty("user.home"))

    const val RULES = "Rules: never ask questions; do NOT spawn subagents (task tool: they hit rate limits); never use tools.rtools.* (use bash with python tools/sigs/*.py and rdis.exe); create/append your progress file after every step; when truly finished set ## NEXT to start with DONE. To syntax-check C++ run only `python tools/cppsyntax.py <file.cpp>`; never run cmd /c, vcvars, cl, start, explorer or open files with a program (it launches Visual Studio)."
    const val NOQ = "Orchestrator: do not ask questions, nobody answers during the run. Choose the most conservative reading of the unit prompt, write the assumption into your progress file as [UNVERIFIED: 0xrva question] if it matters, and continue the unit."
}

val JSON = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

// ---- JsonElement accessors (the only place that touches untyped JSON)
fun JsonElement?.obj(): JsonObject? = this as? JsonObject
fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
fun JsonObject.sub(k: String): JsonObject? = this[k] as? JsonObject
fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray

// ---- domain types
data class ModelRef(val id: String, val providerID: String, val variant: String = "default")

data class Tokens(val input: Long = 0, val output: Long = 0) { val total get() = input + output }

/** A session as opencode reports it. `generating` is the live signal: session.outcome keeps the LAST outcome between turns, busy-newer-than-idle does not. */
data class Session(
    val id: String, val title: String, val outcome: String?, val tokens: Tokens,
    val created: Long, val updated: Long, val busy: Long, val idle: Long, val archivedAt: Long?, val parentID: String?,
) {
    val archived get() = archivedAt != null
    val generating get() = outcome == "running" || busy > idle
    companion object {
        fun parse(o: JsonObject): Session {
            val t = o.sub("time"); val tk = o.sub("tokens")
            return Session(o.str("id") ?: "", o.str("title") ?: "", o.str("outcome"),
                Tokens(tk?.long("input") ?: 0, tk?.long("output") ?: 0),
                t?.long("created") ?: 0, t?.long("updated") ?: 0, t?.long("busy") ?: 0, t?.long("idle") ?: 0, t?.long("archived"), o.str("parentID"))
        }
    }
}

enum class Role { USER, ASSISTANT, OTHER }
/** One message of a session context. `content` stays raw JSON (its size is the context estimate); the few fields we act on are typed. */
data class Message(val role: Role, val created: Long, val completed: Long?, val content: JsonArray) {
    val text: String get() = content.mapNotNull { (it as? JsonObject)?.takeIf { p -> p.str("type") == "text" }?.str("text") }.joinToString("\n").trim()
    val usedQuestionTool: Boolean get() = content.any { val p = it as? JsonObject; p?.str("type") == "tool" && Regex("question", RegexOption.IGNORE_CASE).containsMatchIn(p.str("name") ?: "") }
    val approxTokens: Long get() = (content.toString().length / 3.5).toLong()   // chars / 3.5
    companion object {
        fun parse(o: JsonObject) = Message(when (o.str("type")) { "user" -> Role.USER; "assistant" -> Role.ASSISTANT; else -> Role.OTHER },
            o.sub("time")?.long("created") ?: 0, o.sub("time")?.long("completed"), o.arr("content") ?: JsonArray(emptyList()))
    }
}

/** Every opencode event, typed. Anything not listed is `Other` (kept so unknown event types get announced once). */
sealed interface OcEvent {
    val type: String
    val sessionId: String?
    val data: JsonObject

    /** model is visibly working: refreshes the unit's liveness clock */
    data class Activity(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class StepStarted(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class ExecutionSucceeded(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class ExecutionFailed(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent {
        val errorType get() = data.sub("error")?.str("type") ?: ""
        val isQuota get() = QUOTA.containsMatchIn(data.toString())
        /** the provider side is down (a routed model was withdrawn, no provider serves it): a fresh session cannot help, only waiting can */
        val isProviderOutage get() = OUTAGE.containsMatchIn(data.toString())
    }
    data class ExecutionInterrupted(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class RetryScheduled(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent { val isQuota get() = QUOTA.containsMatchIn(data.toString()) }
    data class BudgetLimit(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class FormCreated(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class PermissionAsked(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class StepFailed(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class Synthetic(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class SessionCreated(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class Compaction(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class Shutdown(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent
    data class Other(override val type: String, override val sessionId: String?, override val data: JsonObject) : OcEvent

    companion object {
        val OUTAGE = Regex("no longer available|no provider serves|model_not_found|temporarily unavailable|overloaded", RegexOption.IGNORE_CASE)
        val QUOTA = Regex("provider\\.quota|provider\\.free-limit|Rate limit|rate_limit|usage limit", RegexOption.IGNORE_CASE)
        private val ACTIVITY = setOf("session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.text.started", "session.text.delta", "session.text.ended",
            "session.tool.input.started", "session.tool.input.delta", "session.tool.input.ended", "session.tool.progress", "session.tool.called", "session.tool.success", "session.tool.failed",
            "session.step.first-token", "session.step.streamed", "session.step.ended", "session.usage.updated")
        /** pure noise: dropped before anything looks at them */
        val QUIET = setOf("session.inbox.enqueued", "session.inbox.delivered", "session.inbox.delivery.changed", "session.instructions.updated", "session.compaction.delta", "session.metadata.updated", "session.viewed",
            "session.renamed", "session.model.selected", "session.agent.selected", "session.permissions", "session.shell.started", "session.shell.ended", "shell.created", "shell.exited", "shell.deleted",
            "form.replied", "form.cancelled", "permission.replied", "project.updated", "server.connected", "session.moved", "plugin.updated", "agent.updated", "command.updated", "config.updated",
            "integration.updated", "model.updated", "provider.updated", "reference.updated", "skill.updated", "websearch.updated", "filesystem.changed", "models-dev.refreshed", "worktree.updated",
            "worktree.created", "worktree.deleted", "vcs.updated", "lsp.updated", "ide.updated", "file.edited", "file.watcher.updated")
        /** worth one journal line each */
        val NOTED = setOf("session.deleted", "session.archived", "session.unarchived", "session.revert.staged", "session.revert.committed", "session.revert.cleared", "session.inbox.cancelled",
            "mcp.status.changed", "mcp.resources.changed", "credential.switched", "credential.updated", "worktree.resolved", "vcs.branch.updated")

        fun parse(o: JsonObject): OcEvent {
            val t = o.str("type") ?: ""; val d = o.sub("data") ?: JsonObject(emptyMap()); val sid = d.str("sessionID")
            return when {
                t in ACTIVITY -> Activity(t, sid, d)
                t == "session.step.started" || t == "session.execution.started" -> StepStarted(t, sid, d)
                t == "session.execution.succeeded" -> ExecutionSucceeded(t, sid, d)
                t == "session.execution.failed" -> ExecutionFailed(t, sid, d)
                t == "session.execution.interrupted" -> ExecutionInterrupted(t, sid, d)
                t == "session.retry.scheduled" -> RetryScheduled(t, sid, d)
                t == "provider.budget-limit" || t == "provider.model-budget-limit" -> BudgetLimit(t, sid, d)
                t == "form.created" -> FormCreated(t, d.sub("form")?.str("sessionID") ?: sid, d)
                t == "permission.asked" -> PermissionAsked(t, sid, d)
                t == "session.step.failed" -> StepFailed(t, sid, d)
                t == "session.synthetic" -> Synthetic(t, sid, d)
                t == "session.created" -> SessionCreated(t, sid, d)
                t.startsWith("session.compaction.") && t != "session.compaction.delta" -> Compaction(t, sid, d)
                t == "location.shutdown" -> Shutdown(t, sid, d)
                else -> Other(t, sid, d)
            }
        }
    }
}

/** Typed internal bus events (what the layers tell each other). */
sealed interface BusEvent {
    data class UnitFinished(val name: String) : BusEvent
    data class UnitStarted(val name: String) : BusEvent
    data object QueueChanged : BusEvent
    data object ReviewRecorded : BusEvent
    data class KeyRotated(val label: String) : BusEvent
    data object KeysExhausted : BusEvent
    data object KeysRecovered : BusEvent
    data object OcReconnected : BusEvent
    data object OcShutdown : BusEvent
}

// ---- logging: journal (SQLite) + keeper-style log file + stdout
object Log {
    private val file get() = File(Cfg.DIR, if (Cfg.SHADOW) "ocd-shadow.log" else "ocd.log")
    private fun write(line: String) { try { file.appendText(Instant.now().toString() + " " + line + "\n") } catch (_: Exception) {} }
    fun log(vararg a: Any?) = write(a.joinToString(" "))
    /** state change / operator-visible line */
    fun say(vararg a: Any?) { val l = a.joinToString(" "); Store.journal("say", "", l); write(l); println(l) }
    fun note(kind: String, who: String, detail: String) { Store.journal(kind, who, detail); write("$kind $who $detail"); println("$kind $who $detail") }
}

// ---- repo files shared with the python tools
object Repo {
    private val NEXT = Regex("## NEXT\\s*\\n([\\s\\S]{0,400})")
    private val DONE = Regex("^\\s*[-:*]?\\s*(DONE\\b|unit complete|all (steps )?(complete|done))", RegexOption.IGNORE_CASE)
    fun isDone(f: File): Boolean = try { NEXT.find(f.readText())?.groupValues?.get(1)?.let { DONE.containsMatchIn(it) } ?: false } catch (_: Exception) { false }
    fun mtime(f: File): Long = f.lastModified()
    fun openItems(): Set<String> = try { Regex("^- \\[ \\] (\\S+) ", RegexOption.MULTILINE).findAll(File(Cfg.REPO, "docs/RENDER_CHECKLIST.md").readText()).map { "U-E" + it.groupValues[1] }.toSet() } catch (_: Exception) { emptySet() }
    fun hintFile(name: String) = File(Cfg.PROG, "hints/" + name.removePrefix("U-E") + ".txt")
    private fun count(f: File, name: String) = try { f.readLines().count { it.trim() == name } } catch (_: Exception) { 0 }
    /** unit start: archive the previous output of this item to oc_<name>_rN.md and consume the review that covered it (append-only files, see tools/nextitems.py) */
    fun archivePrevOutput(name: String, file: File) {
        try {
            if (file.exists()) { var k = 1; while (File(Cfg.PROG, "oc_${name}_r$k.md").exists()) k++; file.renameTo(File(Cfg.PROG, "oc_${name}_r$k.md")); Log.log("archived previous output of", name, "-> _r$k") }
            val net = count(File(Cfg.PROG, "reviewed.txt"), name) - count(File(Cfg.PROG, "reviewed.consumed.txt"), name)
            if (net > 0) { File(Cfg.PROG, "reviewed.consumed.txt").appendText((name + "\n").repeat(net)); Log.log("review consumed for", name, "x$net") }
        } catch (e: Exception) { Log.log("archivePrevOutput failed", name, e.toString().take(100)) }
    }
}

/** run a python tool of the repo, return stdout + exit code */
fun py(vararg args: String): Pair<String, Int?> = try {
    val pb = ProcessBuilder(listOf("python") + args).directory(Cfg.REPO).redirectErrorStream(false); pb.environment()["PYTHONUTF8"] = "1"
    val p = pb.start(); p.outputStream.close()
    val err = Thread { p.errorStream.readBytes() }.also { it.isDaemon = true; it.start() }
    val out = p.inputStream.readBytes().toString(Charsets.UTF_8); val code = p.waitFor(); err.join(2000); out to code
} catch (e: Exception) { "" to null }
fun pyDetached(vararg args: String) { try { val pb = ProcessBuilder(listOf("python") + args).directory(Cfg.REPO).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD); pb.environment()["PYTHONUTF8"] = "1"; pb.start().outputStream.close() } catch (_: Exception) {} }
