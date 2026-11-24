// L0 state: the ONLY durable state of the daemon (SQLite, WAL). Nothing above this layer writes its own state files except the compat mirrors in api.ts.
// Invariants live here as constraints, not as hope:
//   * one live unit per item name   (unique partial index one_live_unit)
//   * one queue entry per item name (UNIQUE queue.name) and per session id
//   * the queue is popped in ONE transaction (pop()), so there is no read-modify-write race
import { Database } from "bun:sqlite";
export const db = new Database("C:/Users/Atomi/opencode-mcp-bridge/" + (process.env.SHADOW ? "ocd-shadow.db" : "ocd.db"), { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
db.exec(`
CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER, updated_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_unit ON units(name) WHERE state IN ('running','stuck');
CREATE TABLE IF NOT EXISTS queue(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, name TEXT UNIQUE, file TEXT, prompt_file TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS keys(label TEXT PRIMARY KEY, cool_until INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, last_status INTEGER, last_probe INTEGER);
CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, unit TEXT, detail TEXT);
`);
export type UnitRow = { id: string; name: string; file: string; state: string; started_at: number; updated_at: number };
export type QueueRow = { seq: number; id: string; name: string; file: string; prompt_file: string; ts: number };
const now = () => Date.now();
const q = {
  addUnit: db.prepare("INSERT OR REPLACE INTO units(id,name,file,state,started_at,updated_at) VALUES(?,?,?,?,?,?)"),
  setState: db.prepare("UPDATE units SET state=?, updated_at=? WHERE id=?"),
  unitsIn: db.prepare("SELECT * FROM units WHERE state IN ('running','stuck')"),
  allUnits: db.prepare("SELECT * FROM units ORDER BY started_at"),
  enqueue: db.prepare("INSERT OR IGNORE INTO queue(id,name,file,prompt_file,ts) VALUES(?,?,?,?,?)"),
  peek: db.prepare("SELECT * FROM queue ORDER BY seq LIMIT 1"),
  del: db.prepare("DELETE FROM queue WHERE seq=?"),
  list: db.prepare("SELECT * FROM queue ORDER BY seq"),
  delName: db.prepare("DELETE FROM queue WHERE name=?"),
  journal: db.prepare("INSERT INTO journal(ts,kind,unit,detail) VALUES(?,?,?,?)"),
  key: db.prepare("INSERT INTO keys(label,cool_until,fails,last_status,last_probe) VALUES(?,?,?,?,?) ON CONFLICT(label) DO UPDATE SET cool_until=excluded.cool_until,fails=excluded.fails,last_status=excluded.last_status,last_probe=excluded.last_probe"),
  keys: db.prepare("SELECT * FROM keys"),
};
export const store = {
  /** register a unit as live. Any other live unit of the same name is retired first (the unique index would reject it). */
  startUnit(id: string, name: string, file: string) {
    db.transaction(() => { db.prepare("UPDATE units SET state='retired', updated_at=? WHERE name=? AND id<>? AND state IN ('running','stuck')").run(now(), name, id); q.addUnit.run(id, name, file, "running", now(), now()); })();
  },
  setState(id: string, state: string) { q.setState.run(state, now(), id); },
  liveUnits(): UnitRow[] { return q.unitsIn.all() as UnitRow[]; },
  allUnits(): UnitRow[] { return q.allUnits.all() as UnitRow[]; },
  enqueue(e: { id: string; name: string; file: string; promptFile: string }): boolean { return q.enqueue.run(e.id, e.name, e.file, e.promptFile, now()).changes > 0; },
  queue(): QueueRow[] { return q.list.all() as QueueRow[]; },
  /** atomically take the head of the queue */
  pop(): QueueRow | undefined { return db.transaction(() => { const r = q.peek.get() as QueueRow | undefined; if (r) q.del.run(r.seq); return r; })(); },
  dropName(name: string): QueueRow[] { return db.transaction(() => { const rows = (q.list.all() as QueueRow[]).filter((r) => r.name === name); q.delName.run(name); return rows; })(); },
  journal(kind: string, unit: string, detail: string) { try { q.journal.run(now(), kind, unit, detail.slice(0, 600)); } catch {} },
  saveKey(label: string, coolUntil: number, fails: number, status: number | null) { q.key.run(label, coolUntil, fails, status, now()); },
  keys(): any[] { return q.keys.all(); },
  recentJournal(n = 100): any[] { return db.prepare("SELECT * FROM journal ORDER BY seq DESC LIMIT ?").all(n); },
};
