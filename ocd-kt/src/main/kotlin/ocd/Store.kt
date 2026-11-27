package ocd

import java.io.File
import java.sql.Connection
import java.sql.DriverManager

data class UnitRow(val id: String, val name: String, val file: String, val state: String)
data class QueueRow(val seq: Long, val id: String, val name: String, val file: String, val promptFile: String)
data class KeyRow(val label: String, val coolUntil: Long, val fails: Int, val lastStatus: Int?, val lastProbe: Long?)
data class JournalRow(val seq: Long, val ts: Long, val kind: String, val unit: String, val detail: String)

/** The ONLY durable state (SQLite, WAL). Same schema as the TypeScript daemon's ocd.db, so a cutover adopts the live database as it is.
 *  Invariants are constraints: one live unit per item (unique partial index), one queue entry per item and per session, the queue pops in ONE transaction. */
object Store {
    private val conn: Connection by lazy {
        Class.forName("org.sqlite.JDBC")
        val c = DriverManager.getConnection("jdbc:sqlite:" + File(Cfg.DIR, if (Cfg.SHADOW) "ocd-kt-shadow.db" else "ocd.db").path)
        c.createStatement().use {
            it.execute("PRAGMA journal_mode=WAL"); it.execute("PRAGMA synchronous=NORMAL"); it.execute("PRAGMA busy_timeout=3000")
            it.execute("CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER, updated_at INTEGER)")
            it.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_live_unit ON units(name) WHERE state IN ('running','stuck')")
            it.execute("CREATE TABLE IF NOT EXISTS queue(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, name TEXT UNIQUE, file TEXT, prompt_file TEXT, ts INTEGER)")
            it.execute("CREATE TABLE IF NOT EXISTS keys(label TEXT PRIMARY KEY, cool_until INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, last_status INTEGER, last_probe INTEGER)")
            it.execute("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT NOT NULL, file TEXT, state TEXT NOT NULL, updated_at INTEGER)")
            it.execute("CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, unit TEXT, detail TEXT)")
        }
        c
    }
    private fun now() = System.currentTimeMillis()

    @Synchronized fun startUnit(id: String, name: String, file: String) {
        conn.autoCommit = false
        try {
            conn.prepareStatement("UPDATE units SET state='retired', updated_at=? WHERE name=? AND id<>? AND state IN ('running','stuck')").use { it.setLong(1, now()); it.setString(2, name); it.setString(3, id); it.executeUpdate() }
            conn.prepareStatement("INSERT OR REPLACE INTO units(id,name,file,state,started_at,updated_at) VALUES(?,?,?,?,?,?)").use { it.setString(1, id); it.setString(2, name); it.setString(3, file); it.setString(4, "running"); it.setLong(5, now()); it.setLong(6, now()); it.executeUpdate() }
            conn.commit()
        } catch (e: Exception) { conn.rollback(); throw e } finally { conn.autoCommit = true }
    }
    @Synchronized fun setState(id: String, state: String) { conn.prepareStatement("UPDATE units SET state=?, updated_at=? WHERE id=?").use { it.setString(1, state); it.setLong(2, now()); it.setString(3, id); it.executeUpdate() } }
    @Synchronized fun liveUnits(): List<UnitRow> = conn.createStatement().use { s -> s.executeQuery("SELECT id,name,file,state FROM units WHERE state IN ('running','stuck')").use { r -> buildList { while (r.next()) add(UnitRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4))) } } }

    data class TaskRow(val id: String, val name: String, val group: String, val file: String)
    @Synchronized fun saveTask(id: String, name: String, group: String, file: String, state: String) { conn.prepareStatement("INSERT OR REPLACE INTO tasks(id,name,grp,file,state,updated_at) VALUES(?,?,?,?,?,?)").use { it.setString(1, id); it.setString(2, name); it.setString(3, group); it.setString(4, file); it.setString(5, state); it.setLong(6, now()); it.executeUpdate() } }
    @Synchronized fun setTaskState(id: String, state: String) { conn.prepareStatement("UPDATE tasks SET state=?, updated_at=? WHERE id=?").use { it.setString(1, state); it.setLong(2, now()); it.setString(3, id); it.executeUpdate() } }
    @Synchronized fun liveTasks(): List<TaskRow> = conn.createStatement().use { s -> s.executeQuery("SELECT id,name,grp,file FROM tasks WHERE state='running'").use { r -> buildList { while (r.next()) add(TaskRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4) ?: "")) } } }

    @Synchronized fun enqueue(id: String, name: String, file: String, promptFile: String): Boolean =
        conn.prepareStatement("INSERT OR IGNORE INTO queue(id,name,file,prompt_file,ts) VALUES(?,?,?,?,?)").use { it.setString(1, id); it.setString(2, name); it.setString(3, file); it.setString(4, promptFile); it.setLong(5, now()); it.executeUpdate() > 0 }
    @Synchronized fun queue(): List<QueueRow> = conn.createStatement().use { s -> s.executeQuery("SELECT seq,id,name,file,prompt_file FROM queue ORDER BY seq").use { r -> buildList { while (r.next()) add(QueueRow(r.getLong(1), r.getString(2), r.getString(3), r.getString(4) ?: "", r.getString(5) ?: "")) } } }
    /** atomically take the head of the queue */
    @Synchronized fun pop(): QueueRow? { val h = queue().firstOrNull() ?: return null; conn.prepareStatement("DELETE FROM queue WHERE seq=?").use { it.setLong(1, h.seq); it.executeUpdate() }; return h }
    @Synchronized fun dropName(name: String): List<QueueRow> { val rows = queue().filter { it.name == name }; conn.prepareStatement("DELETE FROM queue WHERE name=?").use { it.setString(1, name); it.executeUpdate() }; return rows }

    @Synchronized fun journal(kind: String, unit: String, detail: String) {
        try { conn.prepareStatement("INSERT INTO journal(ts,kind,unit,detail) VALUES(?,?,?,?)").use { it.setLong(1, now()); it.setString(2, kind); it.setString(3, unit); it.setString(4, detail.take(600)); it.executeUpdate() } } catch (_: Exception) {}
    }
    @Synchronized fun recentJournal(n: Int = 100): List<JournalRow> = conn.prepareStatement("SELECT seq,ts,kind,unit,detail FROM journal ORDER BY seq DESC LIMIT ?").use { it.setInt(1, n); it.executeQuery().use { r -> buildList { while (r.next()) add(JournalRow(r.getLong(1), r.getLong(2), r.getString(3), r.getString(4) ?: "", r.getString(5) ?: "")) } } }

    @Synchronized fun saveKey(label: String, coolUntil: Long, fails: Int, status: Int?) {
        conn.prepareStatement("INSERT INTO keys(label,cool_until,fails,last_status,last_probe) VALUES(?,?,?,?,?) ON CONFLICT(label) DO UPDATE SET cool_until=excluded.cool_until,fails=excluded.fails,last_status=excluded.last_status,last_probe=excluded.last_probe").use {
            it.setString(1, label); it.setLong(2, coolUntil); it.setInt(3, fails); if (status == null) it.setNull(4, java.sql.Types.INTEGER) else it.setInt(4, status); it.setLong(5, now()); it.executeUpdate() }
    }
    @Synchronized fun keys(): List<KeyRow> = conn.createStatement().use { s -> s.executeQuery("SELECT label,cool_until,fails,last_status,last_probe FROM keys").use { r -> buildList { while (r.next()) add(KeyRow(r.getString(1), r.getLong(2), r.getInt(3), r.getInt(4).takeIf { !r.wasNull() }, r.getLong(5).takeIf { !r.wasNull() })) } } }
}
