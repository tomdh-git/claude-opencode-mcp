// ocd: the opencode unit daemon. One process, one event loop, one store. Layers (each calls only the one below):
//   L5 api.ts (HTTP + file adapters)  L4 ../ocd-run.sh (supervisor)  L3 sched.ts (policy)  L2 runner.ts (unit state machine)  L1 pool.ts (keys)  L0 store.ts + core.ts (state, opencode client, events)
// usage: bun run ocd.ts           live (replaces keeper + refill; stop those first)
//        SHADOW=1 OCD_PORT=4778 bun run ocd.ts   observe-only: same events, decisions journaled as "would ...", no side effects
import fs from "node:fs";
process.chdir("C:/Users/Atomi/opencode-mcp-bridge");
import { SHADOW, DIR, say, log, readJ, bus, eventLoop, MAXRUN } from "./core.ts";
import { store } from "./store.ts";
import * as pool from "./pool.ts";
import * as runner from "./runner.ts";
import * as sched from "./sched.ts";
import * as api from "./api.ts";

// single instance = the port (bind fails when another copy runs). In live mode the old keeper must not be running: two controllers would fight over the same sessions.
let srv: any;
try { srv = api.serve(); } catch (e: any) { console.log("ocd: port " + api.PORT + " busy, another ocd runs; exiting"); process.exit(0); }
if (!SHADOW) {
  try { const kp = Number(fs.readFileSync(DIR + "/keeper.lock", "utf8")); if (kp) { process.kill(kp, 0); if (!process.env.FORCE) { console.log("ocd: the old keeper (pid " + kp + ") is running; stop it first (or FORCE=1)"); process.exit(4); } } } catch {}
  fs.writeFileSync(DIR + "/ocd.lock", String(process.pid));
}
process.on("uncaughtException", (e: any) => log("UNCAUGHT", String(e?.stack ?? e).slice(0, 400)));
process.on("unhandledRejection", (e: any) => log("UNHANDLED-REJECTION", String(e?.stack ?? e).slice(0, 400)));

say("OCD started" + (SHADOW ? " (SHADOW: no side effects)" : "") + " port " + api.PORT + " maxrun " + MAXRUN);
await pool.init(Number(process.env.INITCOOL ?? 0));
// adopt: live units from the store, plus (first run / cutover) what the old keeper left in its files
{
  const seen = new Map<string, any>();
  for (const r of store.liveUnits()) seen.set(r.id, r);
  for (const r of readJ(DIR + "/keeper-units.json", [])) if (!seen.has(r.id)) seen.set(r.id, r);
  await runner.adopt([...seen.values()]);
  if (!SHADOW) for (const q of readJ(DIR + "/keeper-queue.json", [])) store.enqueue({ id: q.id, name: q.name, file: q.file, promptFile: q.promptFile });
}
for (const q of store.queue()) if (runner.units.has(q.id)) store.dropName(q.name);   // queue rows for sessions that are already live units (left by another controller)
sched.setReady();   // adoption is done: from here on the scheduler may start things
void eventLoop(runner.onEvent);
sched.watchReviews();
let tickN = 0;
setInterval(() => { void (async () => { try { if (!SHADOW && ++tickN % 10 === 0) sched.sweepTriage(); await runner.reconcile(); if (pool.auditDue() && !SHADOW) await pool.audit("periodic"); else if (pool.auditDue()) await pool.audit("periodic (shadow)"); void sched.refill(); void sched.pump(); } catch (e) { log("tick error", String(e).slice(0, 100)); } })(); }, 30000);
runner.sweep("start"); void sched.refill(); void sched.pump();
