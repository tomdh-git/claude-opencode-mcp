// L3 scheduler / policy: which item next, how many run, when the queue is topped up. Wakes on bus events (unit.finished, queue.changed, review.recorded), never on file polling.
// The item-selection POLICY (tiers, retry backoff, needs-hint parking, review gate) stays in tools/nextitems.py + tools/mkeasy.py on purpose: they are the shared source of truth with the
// orchestrator's other tools (checklist_status.py, triage.py, pending_yes.py); this layer only calls them. Everything stateful (queue, uniqueness, pop) is in the L0 store.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { c, bus, say, log, note, act, openItems, newSession, REPO, PROG, MAXRUN, TOPUP, MODEL, SHADOW } from "./core.ts";
import { store } from "./store.ts";
import * as runner from "./runner.ts";
import * as pool from "./pool.ts";

const py = (args: string[]) => new Promise<string>((res) => { const p = spawn("python", args, { cwd: REPO, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); let o = ""; p.stdout.on("data", (d: any) => (o += d)); p.on("error", () => res(o)); p.on("close", () => res(o)); });

// nothing is scheduled until the daemon has adopted the units that are already running (a pump before adoption started every queued entry a second time)
let ready = false; export const setReady = () => { ready = true; };
// ---- pump: move queue heads into free slots
let pumping = false, pumpAgain = false;
export async function pump() {
  if (SHADOW || !ready) return;
  if (pumping) { pumpAgain = true; return; } if (pool.isPaused()) return; pumping = true;
  try {
    while (runner.active().length < MAXRUN) {
      const e = store.pop(); if (!e) break;
      // the same SESSION is already a live unit (adopted from another controller): never start it twice (that re-prompts it and archives its running output file)
      if (runner.units.has(e.id)) { log("queue entry dropped, session already a live unit:", e.name); continue; }
      if (!openItems().has(e.name)) { log("queue entry dropped, checklist item already ticked:", e.name); void act("archive", () => c.session.update({ sessionID: e.id, archived: true })).catch(() => {}); continue; }
      if (runner.active().some((u) => u.name === e.name && u.id !== e.id)) { log("queue entry dropped, unit already running:", e.name); void act("archive", () => c.session.update({ sessionID: e.id, archived: true })).catch(() => {}); continue; }
      await runner.start(e);
      say("STARTED " + e.name + " from queue (" + store.queue().length + " left)"); bus.emit("queue.changed");
    }
  } catch (err) { log("pump error", String(err).slice(0, 120)); }
  finally { pumping = false; if (pumpAgain) { pumpAgain = false; void pump(); } }
}
export function drop(name: string) { for (const r of store.dropName(name)) { note("QUEUE", r.name, "dropped"); bus.emit("queue.changed"); void act("archive", () => c.session.update({ sessionID: r.id, archived: true })).catch(() => {}); } }

// ---- refill: keep TOPUP pre-created units queued
let busy = false, again = false;
export async function refill() {
  if (SHADOW || !ready) return;
  if (busy) { again = true; return; } busy = true;
  try {
    const open = openItems();
    const pending = new Set(store.queue().filter((r) => open.has(r.name)).map((r) => r.name));
    const need = TOPUP - pending.size; if (need <= 0) return;
    const live = new Set<string>();
    try { const l: any = await c.session.list(); for (const x of (l.data ?? l)) { if (x.time?.archived) continue; if (x.outcome === "running" || (!x.outcome && Date.now() - (x.time?.updated ?? 0) < 600000)) live.add(x.title); } } catch (e) { log("session list failed, not refilling", String(e).slice(0, 100)); return; }
    for (const u of runner.live()) live.add(u.name);
    const ids = (await py(["tools/nextitems.py", String(need + 8)])).split(/\r?\n/).filter(Boolean);
    let made = 0;
    for (const id of ids) {
      const name = "U-E" + id; if (made >= need) break;
      if (pending.has(name) || live.has(name)) continue;
      const promptFile = `${PROG}/_p_${name}.txt`; await py(["tools/mkeasy.py", id]);
      if (!fs.existsSync(promptFile)) { log("no prompt for", id); continue; }
      const sid = await newSession(name);
      if (store.enqueue({ id: sid, name, file: `${PROG}/oc_${name}.md`, promptFile })) { pending.add(name); made++; say(new Date().toISOString(), "queued", name, sid); bus.emit("queue.changed"); }
      else void c.session.update({ sessionID: sid, archived: true }).catch(() => {});   // the store refused a duplicate: never keep the orphan session
    }
  } catch (e) { log("refill error", String(e).slice(0, 200)); } finally { busy = false; if (again) { again = false; void refill(); } else void pump(); }
}
bus.on("unit.finished", () => { void pump(); void refill(); });
bus.on("unit.started", () => void refill());   // NOT queue.changed: refill/pump/sweep emit that one (mirrors listen to it); refill listening to it looped forever
bus.on("review.recorded", () => void refill());
bus.on("keys.recovered", () => void pump());
bus.on("key.rotated", () => void pump());
// the single remaining file watch of this layer: the orchestrator's reviews (checklist_status.py / triage.py append to reviewed.txt) make items eligible again
export function watchReviews() {
  try { fs.watch(PROG, (_e, f) => { if (f === "reviewed.txt" || f === "needs_hint.txt") bus.emit("review.recorded"); }); } catch {}
  try { fs.watch(PROG + "/hints", () => bus.emit("review.recorded")); } catch {}
}

// finished outputs nobody triaged would block their item as "awaiting review" and starve the slots: triage them (zero model; verify-kind ones stay for the orchestrator)
export function sweepTriage() { try { const p = spawn("python", ["tools/triage.py", "--sweep"], { cwd: REPO, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); p.on("close", () => bus.emit("review.recorded")); } catch {} }
