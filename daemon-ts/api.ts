// L5 API + compat adapters. The HTTP API is the real interface; the file adapters exist so the existing orchestrator tools keep working unchanged:
//   nudge-inbox/<unit>.txt  (tools/nudge.py, MCP oc_nudge)   queue-drop.txt   keeper.kick / keeper.sweep / keeper.rotate (touch)   queue-inbox/*.json (old refill, ignored)
// and derived mirrors for readers of the old files: keeper-units.json, keeper-queue.json, watchdog-status.json (written atomically, never read back as state).
import fs from "node:fs";
import { bus, say, log, note, readJ, writeJ, DIR, REPO, PROG, MAXRUN, SHADOW } from "./core.ts";
import { store } from "./store.ts";
import * as runner from "./runner.ts";
import * as sched from "./sched.ts";
import * as pool from "./pool.ts";

export const PORT = Number(process.env.OCD_PORT ?? 4777);
const started = Date.now();
export function snapshot() {
  const us = runner.status();
  return { ok: true, pid: process.pid, uptimeS: Math.round((Date.now() - started) / 1000), shadow: SHADOW, maxrun: MAXRUN, running: runner.active().length, generating: us.filter((x) => x.running).length, units: us, queue: store.queue().map((r) => r.name), keys: pool.summary(), journal: store.recentJournal(15) };
}
async function nudgeFiles() {
  const dir = DIR + "/nudge-inbox"; let fl: string[] = []; try { fl = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")); } catch { return; }
  for (const f of fl) { const p = dir + "/" + f; let t = ""; try { t = fs.readFileSync(p, "utf8").trim(); fs.unlinkSync(p); } catch { continue; } if (!t) continue; await command(f.replace(/(\.\d+)?\.txt$/, ""), t); }
}
/** one entry point for every operator command, whatever transport it arrived on */
export async function command(unit: string, text: string) {
  if (/^!drop(?!\w)/.test(text)) { sched.drop(unit); return { ok: true, dropped: unit }; }
  await runner.nudge(unit, text); return { ok: true };
}
let mirrorTimer: any = null;
function mirrors() { if (mirrorTimer) return; mirrorTimer = setTimeout(() => { mirrorTimer = null; writeMirrors(); }, 300); }   // debounced: one write per burst
function writeMirrors() {
  try {
    writeJ(DIR + "/keeper-units.json", runner.live().map((u) => ({ id: u.id, name: u.name, file: u.file })));
    writeJ(DIR + "/keeper-queue.json", store.queue().map((r) => ({ id: r.id, name: r.name, file: r.file, promptFile: r.prompt_file })));
    const act = runner.active().length;
    fs.writeFileSync(DIR + "/watchdog-status.json", JSON.stringify({ at: new Date().toISOString(), running: act, target: MAXRUN, cores: runner.live().length, tps: null, quota: 0, zeroTps: 0, by: "ocd" }));
  } catch (e) { log("mirror write failed", String(e).slice(0, 80)); }
}
export function serve() {
  const srv = Bun.serve({
    port: PORT, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url); const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
      if (u.pathname === "/health") return j({ ok: true, pid: process.pid });
      if (u.pathname === "/status") return j(snapshot());
      if (u.pathname === "/journal") return j(store.recentJournal(Number(u.searchParams.get("n") ?? 100)));
      if (u.pathname === "/digest") { try { return new Response(fs.readFileSync(PROG + "/DIGEST.md", "utf8")); } catch { return j({ error: "no digest" }, 404); } }
      if (req.method === "POST" && u.pathname === "/nudge") { const b: any = await req.json().catch(() => ({})); if (!b.unit || !b.message) return j({ error: "unit and message required" }, 400); return j(await command(b.unit, b.message)); }
      if (req.method === "POST" && u.pathname === "/kick") { runner.resetStuck(); runner.sweep("kick"); void sched.pump(); return j({ ok: true }); }
      if (req.method === "POST" && u.pathname === "/rotate") { void pool.onQuota("operator request", true); return j({ ok: true }); }
      if (req.method === "POST" && u.pathname === "/review") { bus.emit("review.recorded"); return j({ ok: true }); }
      if (u.pathname === "/events") {   // SSE of the bus
        let off = () => {}; const s = new ReadableStream({ start(ctl) { const enc = new TextEncoder(); const hs: [string, (...a: any[]) => void][] = []; for (const t of ["unit.finished", "unit.started", "queue.changed", "key.rotated", "keys.exhausted", "keys.recovered"]) { const h = (x: any) => { try { ctl.enqueue(enc.encode("event: " + t + "\ndata: " + JSON.stringify(x ?? null) + "\n\n")); } catch {} }; bus.on(t, h); hs.push([t, h]); } off = () => hs.forEach(([t, h]) => bus.off(t, h)); }, cancel() { off(); } });
        return new Response(s, { headers: { "content-type": "text/event-stream" } });
      }
      return j({ error: "not found" }, 404);
    },
  });
  if (SHADOW) { log("shadow: HTTP only, no file adapters, no mirrors"); return srv; }
  // file adapters (event driven)
  fs.mkdirSync(DIR + "/nudge-inbox", { recursive: true });
  fs.watch(DIR + "/nudge-inbox", () => void nudgeFiles()); void nudgeFiles();
  fs.watch(DIR, (_e, f) => {
    if (f === "queue-drop.txt") { try { const t = fs.readFileSync(DIR + "/queue-drop.txt", "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean); if (t.length) { fs.writeFileSync(DIR + "/queue-drop.txt", ""); t.forEach(sched.drop); } } catch {} }
    else if (f === "keeper.kick") { runner.resetStuck(); runner.sweep("kick"); void sched.pump(); }
    else if (f === "keeper.sweep") { runner.sweep("sweep"); void sched.pump(); }
    else if (f === "keeper.rotate") void pool.onQuota("rotate requested", true);
  });
  for (const t of ["unit.started", "unit.finished", "queue.changed", "key.rotated"]) bus.on(t, mirrors);
  mirrors();
  return srv;
}
