// L2 unit runner: the life of one unit. Rewritten around ONE rule: the session itself is the truth (outcome, archived, last assistant message), never our own flags.
//   units are live | done | retired.  A unit that makes no progress is ROTATED (fresh session, same progress file) a bounded number of times, then RETIRED (session archived, item requeues through nextitems).
//   Nothing is "stuck" any more: a stuck unit that keeps a slot and blocks its item was the worst failure of the old runner.
// Driven by opencode events (onEvent); a 30 s reconcile checks every unit against the real session state and repairs (missed DONE, dead flag, archived-from-outside, stall, idle without a continue).
// Sends are rate-limited per unit (MIN_GAP) and every interruption is stop-then-send: we interrupt, WAIT until the session really stopped, and only then prompt (a prompt to a busy session only queues).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { c, bus, say, note, log, act, prompt, sleep, isDone, archivePrevOutput, hintPath, newSession, fmtime, REPO, PROG, RULES, NOQ, MODEL, STALL_MS, SHADOW } from "./core.ts";
import { store, type QueueRow } from "./store.ts";
import * as pool from "./pool.ts";

const MIN_GAP = Number(process.env.MIN_GAP_S ?? 20) * 1000;      // never two prompts to one unit closer than this
const CTX_MAX = Number(process.env.CTX_MAX ?? 150000);            // estimated tokens of the unit's context; above it the next turn boundary rotates to a fresh session
const MAX_ROT = Number(process.env.MAX_ROT ?? 3);                 // rotations per item per 6 h before the unit is retired instead
const NOPROG_MAX = 6;                                             // continue-sends in a row without token OR progress-file movement
const FAIL_ROTATE = 6;                                            // consecutive failed executions (provider errors on a huge context) before rotating

export type U = { id: string; name: string; file: string; running: boolean; busy: boolean; again: boolean; done: boolean; stuck: boolean; noProg: number; tokAtSend: number; fileAtSend: number; intAuto: number; stallKicks: number; consFail: number; toolFails: number; lastTool: string; lastEv: number; lastAct: number; lastSend: number; retryAt: number; stopping: boolean; spawns: number; ctx: number; msg?: string };
export const units = new Map<string, U>();
const mk = (id: string, name: string, file: string): U => ({ id, name, file, running: false, busy: false, again: false, done: false, stuck: false, noProg: 0, tokAtSend: 0, fileAtSend: 0, intAuto: 0, stallKicks: 0, consFail: 0, toolFails: 0, lastTool: "", lastEv: Date.now(), lastAct: Date.now(), lastSend: 0, retryAt: 0, stopping: false, spawns: 0, ctx: 0 });
export const byName = (n: string) => [...units.values()].find((u) => u.name === n && !u.done);
// capacity = every live unit (a unit between two turns still owns its slot; units that are gone from opencode are dropped by reconcile, so this count is honest)
export const active = () => [...units.values()].filter((u) => !u.done);
export const live = () => active();
const ownCache = new Map<string, boolean>();
const rots = new Map<string, number[]>();

// ---- helpers over the real session
async function sess(u: U): Promise<any | null> { try { return await c.session.get({ sessionID: u.id }); } catch (e) { return /not.?found|404|no such/i.test(String(e)) ? null : undefined; } }   // null = gone, undefined = could not tell
const isArchived = (s: any) => !!s?.time?.archived;
/** generating NOW. session.outcome is stale between turns (it keeps the LAST outcome); the live signal is busy newer than idle */
const isGen = (s: any) => s?.outcome === "running" || (s?.time?.busy ?? 0) > (s?.time?.idle ?? 0);
/** interrupt and WAIT until the session has really stopped (a prompt sent before that only queues) */
async function stop(u: U) {
  if (SHADOW) { store.journal("would", "", "stop " + u.id); return; }
  u.stopping = true;
  try { await c.session.interrupt({ sessionID: u.id }); } catch {}
  for (let i = 0; i < 12; i++) { await sleep(1000); const s = await sess(u); if (!s || !isGen(s)) break; }
  u.running = false; setTimeout(() => { u.stopping = false; }, 3000);
}
function ctxEstimate(msgs: any[]): number { let n = 0; for (const m of msgs) { try { n += JSON.stringify(m.content ?? "").length; } catch {} } return Math.round(n / 3.5); }
const messages = (r: any): any[] => (Array.isArray(r) ? r : Object.values(r ?? {}));

/** remove a unit from the daemon (the session is archived unless it already is). The item's progress file is untouched; the item requeues through nextitems. */
export async function retire(u: U, why: string, archive = true) {
  if (u.done) return;
  u.done = true; u.running = false; store.setState(u.id, "retired"); note("RETIRED", u.name, why);
  if (archive) { try { await act("interrupt " + u.id, () => c.session.interrupt({ sessionID: u.id })); } catch {} await sleep(1500); try { await act("archive " + u.id, () => c.session.update({ sessionID: u.id, archived: true })); } catch {} }
  units.delete(u.id); bus.emit("unit.finished", u.name);
}
/** fresh session for the same item: the progress file and the source files already written carry the state, the new session starts with an empty context */
async function rotate(u: U, why: string) {
  if (u.done) return;
  const rs = (rots.get(u.name) ?? []).filter((t) => Date.now() - t < 6 * 3600e3);
  if (rs.length >= MAX_ROT) { await retire(u, "rotation budget used (" + MAX_ROT + "/6h), last reason: " + why); return; }
  rs.push(Date.now()); rots.set(u.name, rs);
  note("ROTATE", u.name, why + ": fresh session (" + rs.length + "/" + MAX_ROT + "), the progress file carries the state");
  if (SHADOW) return;
  let base = ""; try { base = fs.readFileSync(PROG + "/_p_" + u.name + ".txt", "utf8"); } catch {}
  if (!base) { await retire(u, "rotate: no prompt file to restart from, retiring (" + why + ")"); return; }
  let sid: string; try { sid = await newSession(u.name); } catch (e) { log(u.name, "rotate: newSession failed", String(e).slice(0, 100)); return; }
  u.done = true; u.running = false; units.delete(u.id); store.setState(u.id, "retired");
  try { await c.session.interrupt({ sessionID: u.id }); } catch {} setTimeout(() => void c.session.update({ sessionID: u.id, archived: true }).catch(() => {}), 2000);
  const n = mk(sid, u.name, u.file); n.running = true; n.lastSend = Date.now(); units.set(sid, n); store.startUnit(sid, u.name, u.file);
  await prompt(sid, base + "\nCONTINUATION: an earlier session of this unit was replaced (" + why + "). Do NOT start over: your progress file " + u.file + " and the source files already written hold the state. Read the progress file (## NEXT), check the source files it names, and continue exactly where it stops. " + RULES);
  bus.emit("unit.started", u.name);
}

// ---- startup: adopt what the previous process left running, drop what is dead
export async function adopt(rows: { id: string; name: string; file: string }[]) {
  for (const r of rows) {
    if (isDone(r.file)) continue;
    const u = mk(r.id, r.name, r.file); const s = await sess(u);
    if (!s) continue; if (isArchived(s) && !isGen(s)) continue;
    u.running = isGen(s); units.set(r.id, u); store.startUnit(r.id, r.name, r.file);
  }
  log("adopted", units.size, "units");
  for (const u of units.values()) { try { const fl: any = await c.session.form.list({ sessionID: u.id }); for (const f of fl ?? []) await cancelForm(u.id, f.id, f.title ?? ""); } catch {} }
}
/** L3 calls this when a slot is free and the head of the queue passed its checks */
export async function start(e: QueueRow) {
  archivePrevOutput(e.name, e.file);
  for (const old of [...units.values()].filter((x) => x.name === e.name && x.id !== e.id && !x.done)) await retire(old, "replaced by a queued session of the same item");
  const u = mk(e.id, e.name, e.file); units.set(e.id, u); u.running = true; u.lastSend = Date.now(); store.startUnit(e.id, e.name, e.file);
  await prompt(e.id, fs.readFileSync(e.prompt_file, "utf8"));
  bus.emit("unit.started", e.name);
}

// ---- done gate: chunk units must quote every listed instruction (tools/chunkcheck.py); otherwise the unit is reopened with the exact missing lines
const gateFails = new Map<string, number>();
const py = (args: string[]) => new Promise<{ out: string; code: number | null; err: string }>((res) => { const p = spawn("python", args, { cwd: REPO, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = ""; p.stdout.on("data", (d: any) => (o += d)); p.stderr.on("data", (d: any) => (e += d)); p.on("error", () => res({ out: o, code: null, err: e })); p.on("close", (code: any) => res({ out: o, code, err: e })); });
async function doneGate(u: U): Promise<boolean> {
  const nm = u.name.replace(/^U-/, "");
  if (!fs.existsSync(PROG + "/_part_" + nm + ".txt")) return true;
  const r = await py(["tools/chunkcheck.py", u.name]);
  const miss = r.out.split("\n").filter((l) => l.startsWith("MISSING ")).map((l) => l.slice(8));
  const cov = /(\d+)\/(\d+) instructions quoted/.exec(r.out);
  if (!miss.length && /CHECK OK/.test(r.out)) return true;
  if (!cov) { say(u.name, "GATE: no coverage line (transient)"); return false; }
  const n = (gateFails.get(u.id) ?? 0) + 1; gateFails.set(u.id, n);
  if (n > 4) { say(u.name, "GATE: still failing after 4 tries, accepting for review (" + cov[0] + ")"); return true; }
  const reopen = (txt: string) => { if (SHADOW) return; try { fs.writeFileSync(u.file, fs.readFileSync(u.file, "utf8").replace(/^(## NEXT\s*\n)\s*(DONE|COMPLETE)[^\n]*/m, "$1" + txt)); } catch {} };
  if (!miss.length) {
    const fails = r.out.split("\n").filter((l) => l.startsWith("- ")).join("\n");
    say(u.name, "GATE: DONE rejected (coverage ok, structure check failed), sending failures back"); reopen("step 3: fix the failures sent by the orchestrator");
    await send(u, "Your DONE was rejected by `python tools/delegate.py check " + u.file + "`. Fix exactly these failures in " + u.file + " (do not rewrite the whole file, keep every quoted instruction line), rerun the check until it prints CHECK OK, then set the line after ## NEXT to DONE:\n" + fails + "\n" + RULES);
  } else {
    say(u.name, "GATE: DONE rejected (" + cov[0] + "), sending back " + miss.length + " missing lines"); reopen("step 3: the orchestrator found missing instructions, append them (see message)");
    await send(u, "Your DONE was rejected by the coverage check: " + cov[0] + ". These listed instructions are not quoted anywhere in " + u.file + " (quote each as `0xRVA  instr` inside phases, append them, do not rewrite the file):\n" + miss.join("\n") + "\nThen run `python tools/chunkcheck.py " + u.name + "` until it prints no MISSING lines and set the line after ## NEXT to DONE. " + RULES);
  }
  u.running = true; return false;
}
const triage = (name: string) => { if (SHADOW) return; try { const p = spawn("python", ["tools/triage.py", name], { cwd: REPO, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); log(name, "triage started"); } catch {} };
function finish(u: U) {
  u.done = true; u.running = false; store.setState(u.id, "done"); say(u.name, u.id, "DONE (file says complete)"); triage(u.name);
  setTimeout(() => { void act("archive " + u.id, () => c.session.update({ sessionID: u.id, archived: true })).catch(() => {}); units.delete(u.id); }, 30000);
  bus.emit("unit.finished", u.name);
}
/** every prompt to a unit goes through here: it records the send time (rate limit) */
async function send(u: U, text: string) { u.lastSend = Date.now(); u.running = true; await prompt(u.id, text); }

// ---- continue / answer: the single decision point for "this unit's turn ended"
export async function handle(u: U, why: string) {
  if (u.done) return;
  if (isDone(u.file)) { if (!(await doneGate(u)) || u.done) return; finish(u); return; }
  if (pool.isPaused()) { log(u.name, "paused: all keys cooling"); return; }
  if (u.busy) { u.again = true; return; }
  const wait = Math.max(u.retryAt, u.lastSend + MIN_GAP) - Date.now();
  if (wait > 0) { setTimeout(() => void handle(u, why + " (delayed)"), wait + 200); return; }   // rate limit / failure backoff: later, not never
  u.busy = true;
  try {
    const s = await sess(u);
    if (s === null || (s && isArchived(s) && !isGen(s))) { await retire(u, "session gone or archived outside the daemon", false); return; }
    if (!s) return;
    if (isGen(s)) { u.running = true; return; }                 // really generating: nothing to do
    const r: any = await c.session.context({ sessionID: u.id }); const msgs = messages(r); const last = msgs[msgs.length - 1];
    if (last && (last.type === "user" || (last.type === "assistant" && !last.time?.completed)) && Date.now() - (last.time?.created ?? 0) < 90000) { u.running = true; log(u.name, "busy (" + last.type + "), no send"); return; }
    u.ctx = ctxEstimate(msgs);
    if (u.ctx > CTX_MAX) { await rotate(u, "context ~" + Math.round(u.ctx / 1000) + "k tokens (> " + Math.round(CTX_MAX / 1000) + "k)"); return; }
    // progress = the session spent tokens OR the progress file moved since the last send
    const tok = (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), fm = fmtime(u.file);
    if (u.lastSend) { if (tok - u.tokAtSend >= 1500 || fm > u.fileAtSend) u.noProg = 0; else u.noProg++; }
    if (u.noProg >= NOPROG_MAX) { await rotate(u, NOPROG_MAX + " sends without progress"); return; }
    const la = [...msgs].reverse().find((m) => m.type === "assistant");
    const texts = (la?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text as string).join("\n").trim();
    const asked = (la?.content ?? []).some((p: any) => p.type === "tool" && /question/i.test(p.name ?? "")) || (last === la && la?.time?.completed && /\?\s*$/.test(texts));
    u.tokAtSend = tok; u.fileAtSend = fm;
    if (asked) { say("QUESTION", u.name, texts.slice(-200).replace(/\n/g, " ")); await send(u, NOQ + " Your question was: " + texts.slice(-300) + " " + RULES); }
    else { await send(u, (u.msg ?? "") + " Your turn ended but the unit is not finished (if your progress file " + u.file + " is missing, create it now). Re-read it (## NEXT) and continue. " + RULES); log(u.name, "continue sent (" + why + ")"); }
  } catch (e) { log(u.name, "handle error", String(e).slice(0, 120)); }
  finally { u.busy = false; if (u.again) { u.again = false; setTimeout(() => void handle(u, "again"), 1000); } }
}
export function sweep(why: string) { for (const u of units.values()) if (!u.running && !u.done) void handle(u, why); }

async function cancelForm(sessionID: string, formID: string, title: string) { try { await act("cancel form", () => c.session.form.cancel({ sessionID, formID, message: NOQ + " (the form was cancelled automatically: " + title.slice(0, 120) + ")" })); say("QUESTION auto-cancelled form in", sessionID, title.slice(0, 120)); } catch (e) { log("form cancel failed", String(e).slice(0, 120)); } }
async function rejectPermission(sessionID: string, requestID: string) { try { await act("reject permission", () => c.permission.reply({ sessionID, requestID, decision: "reject", message: "Orchestrator: permission requests are not answered during the run. Use only repo files, bash with python tools/sigs/*.py and rdis.exe, and write only docs/progress/*, docs/listings/*, tools/sigs/*. Continue the unit without it." })); say("PERMISSION auto-rejected in", sessionID); } catch (e) { log("permission reply failed", String(e).slice(0, 120)); } }
async function ours(sid: string): Promise<boolean> {
  if (ownCache.has(sid)) return ownCache.get(sid)!;
  let id: string | undefined = sid, ok = false;
  for (let d = 0; d < 5 && id; d++) { if (units.has(id)) { ok = true; break; } try { const x: any = await c.session.get({ sessionID: id }); id = x.parentID; } catch { break; } }
  ownCache.set(sid, ok); return ok;
}
export async function interruptAll() {
  for (const u of units.values()) { if (u.done) continue; u.stopping = true; try { await act("interrupt " + u.id, () => c.session.interrupt({ sessionID: u.id })); } catch {} u.running = false; u.busy = false; u.again = false; setTimeout(() => { u.stopping = false; }, 5000); }
  await sleep(2500); log("interrupted all unit chats");
}
bus.on("keys.exhausted", () => void interruptAll());                       // nothing keeps firing into dead keys
bus.on("keys.recovered", () => { for (const u of units.values()) { u.noProg = 0; u.consFail = 0; u.retryAt = 0; } say("KEY recovered, continuing units"); sweep("keys back"); });
bus.on("key.rotated", () => { for (const u of units.values()) { u.noProg = 0; u.consFail = 0; u.retryAt = 0; } sweep("rotated"); });
bus.on("oc.reconnected", () => void reconcile());
bus.on("oc.shutdown", () => { void (async () => { await sleep(6000); say("server restarted: interrupting dead in-flight calls, then reconciling units"); await interruptAll(); await reconcile(); })(); });

const short = (x: any) => JSON.stringify(x ?? "").replace(/\s+/g, " ").slice(0, 200);
const isQuota = (d: any) => /provider\.quota|provider\.free-limit|Rate limit|rate_limit|usage limit/i.test(JSON.stringify(d ?? {}));
const seenUnknown = new Set<string>();
// events that prove the model is working: they refresh lastAct. (retry / failure events deliberately do NOT: a unit that only retries is stalled)
const ACT = new Set(["session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.text.started", "session.text.delta", "session.text.ended", "session.tool.input.started", "session.tool.input.delta", "session.tool.input.ended", "session.tool.progress", "session.tool.called", "session.tool.success", "session.tool.failed", "session.step.first-token", "session.step.streamed", "session.step.ended", "session.usage.updated"]);
const QUIET = new Set(["session.inbox.enqueued", "session.inbox.delivered", "session.inbox.delivery.changed", "session.instructions.updated", "session.compaction.delta", "session.metadata.updated", "session.viewed", "session.renamed", "session.model.selected", "session.agent.selected", "session.permissions", "session.shell.started", "session.shell.ended", "shell.created", "shell.exited", "shell.deleted", "form.replied", "form.cancelled", "permission.replied", "project.updated", "server.connected", "session.moved", "plugin.updated", "agent.updated", "command.updated", "config.updated", "integration.updated", "model.updated", "provider.updated", "reference.updated", "skill.updated", "websearch.updated", "filesystem.changed", "models-dev.refreshed", "worktree.updated", "worktree.created", "worktree.deleted", "vcs.updated", "lsp.updated", "ide.updated", "file.edited", "file.watcher.updated", "location.shutdown"]);
const NOTED = new Set(["session.deleted", "session.archived", "session.unarchived", "session.revert.staged", "session.revert.committed", "session.revert.cleared", "session.inbox.cancelled", "mcp.status.changed", "mcp.resources.changed", "credential.switched", "credential.updated", "worktree.resolved", "vcs.branch.updated"]);

/** EVERY opencode event lands here; each type is either acted on, tracked, noted, or explicitly quiet. Unknown types are announced once. */
export async function onEvent(e: any) {
  const d = e.data ?? {}; const u = d.sessionID ? units.get(d.sessionID) : undefined;
  if (u) { u.lastEv = Date.now(); if (ACT.has(e.type)) { u.lastAct = Date.now(); if (e.type === "session.step.ended") { u.intAuto = 0; u.stallKicks = 0; u.consFail = 0; u.retryAt = 0; } else if (e.type === "session.tool.success") u.toolFails = 0; else if (e.type === "session.tool.called") u.lastTool = (d.name ?? "") + " " + short(d.input); else if (e.type === "session.tool.failed") { u.toolFails++; if (u.toolFails === 3 || u.toolFails % 10 === 0) note("TOOL-FAILING", u.name, u.toolFails + " tool failures in a row, last: " + u.lastTool.slice(0, 120) + " :: " + short(d.error ?? d).slice(0, 120)); } return; } }
  if (QUIET.has(e.type) || (!u && ACT.has(e.type))) return;
  const who = u ? u.name : (d.sessionID ?? "global");
  switch (e.type) {
    case "session.step.started": case "session.execution.started": if (u) { u.running = true; u.lastAct = Date.now(); } return;
    case "session.execution.succeeded": if (u) { u.running = false; u.consFail = 0; u.intAuto = 0; u.stallKicks = 0; void handle(u, "succeeded"); sweep("slot free"); } return;
    case "session.execution.failed": if (u) {
      u.running = false; note("EXECUTION-FAILED", who, short(d));
      const et = String(d?.error?.type ?? "");
      if (isQuota(d)) await pool.onQuota("execution failed: quota");
      if (et === "provider.no-route") { try { await act("switchModel", () => c.session.switchModel({ sessionID: u.id, model: MODEL })); note("MODEL-RESET", who, "no-route -> " + MODEL.id); } catch (er) { log(u.name, "switchModel failed", String(er).slice(0, 100)); } }
      const n = ++u.consFail;
      if (n >= FAIL_ROTATE && !isQuota(d)) { void rotate(u, n + " failed executions in a row (" + et + ")"); return; }
      u.retryAt = Date.now() + Math.min(120000, 5000 * 2 ** Math.min(n - 1, 5));   // exponential backoff: a failing provider is not hammered
      void handle(u, "failed"); sweep("slot free");
    } return;
    case "session.execution.interrupted": if (u) {
      u.running = false; if (u.stopping) return;                                   // we interrupted it ourselves and drive the restart explicitly
      const n = ++u.intAuto; if (!isDone(u.file) && n <= 3) { note("INTERRUPTED", who, "auto-continuing (" + n + "/3)"); void handle(u, "interrupted"); } else note("INTERRUPTED", who, isDone(u.file) ? "file is DONE, nothing to continue" : "3 auto-continues used, the 30 s reconcile decides"); } return;
    case "session.retry.scheduled": if (u) { note("RETRY", who, short(d)); if (isQuota(d)) void pool.onQuota("retry scheduled: quota"); } return;
    case "provider.budget-limit": case "provider.model-budget-limit": note("BUDGET-LIMIT", "global", e.type + " " + short(d)); void pool.onQuota(e.type); return;
    case "form.created": { const f = d.form ?? {}; if (f.sessionID && (await ours(f.sessionID))) await cancelForm(f.sessionID, f.id, f.title ?? short(f.fields)); else note("FORM", who, "form in a session that is not a unit's (left alone) " + short(f).slice(0, 120)); return; }
    case "permission.asked": if (d.sessionID && (await ours(d.sessionID))) await rejectPermission(d.sessionID, d.id ?? d.requestID); else note("PERMISSION", who, "request in a session that is not a unit's (left alone)"); return;
    case "session.step.failed": if (u) note("STEP-FAILED", who, short(d).slice(0, 140)); else log("step failed in non-unit session", who, short(d).slice(0, 100)); return;
    case "session.synthetic": { const t = short(d); if (/error/i.test(t)) note("SUBAGENT-ERROR", who, t); else if (u) note("SUBAGENT-RESULT", who, t.slice(0, 120)); return; }
    case "session.created": if (d.parentID && (await ours(d.parentID))) { const p = units.get(d.parentID); if (p) { p.spawns++; if (p.spawns === 1 || p.spawns % 10 === 0) note("SUBAGENT-SPAWNED", d.parentID, p.spawns + " subagent(s) spawned by this unit so far (rules forbid it)"); } } return;
    case "session.compaction.started": case "session.compaction.ended": case "session.compaction.failed": if (u || (d.sessionID && (await ours(d.sessionID)))) note(e.type.toUpperCase().replace("SESSION.", ""), who, short(d).slice(0, 120)); return;
  }
  if (NOTED.has(e.type)) { note(e.type.toUpperCase(), who, short(d).slice(0, 160)); return; }
  if (e.type.startsWith("rpc.")) return;
  if (!seenUnknown.has(e.type)) { seenUnknown.add(e.type); note("UNKNOWN-EVENT", who, e.type + " (first occurrence) " + short(d).slice(0, 160)); } else log("unknown event", e.type);
}

// ---- reconcile (30 s): compare every unit with the REAL session and repair. This is what catches stalls, ghosts and missed events.
let reconciling = false;
export async function reconcile() {
  if (reconciling) return; reconciling = true;
  try {
    for (const u of [...units.values()]) {
      if (u.done) continue;
      if (isDone(u.file)) { log(u.name, "reconcile: file is DONE"); void handle(u, "reconcile"); continue; }
      if (u.busy) continue;
      const s = await sess(u);
      if (s === null || (s && isArchived(s) && !isGen(s))) { await retire(u, "reconcile: session gone or archived outside the daemon", false); continue; }
      if (!s) continue;                                                           // opencode did not answer: decide nothing
      const gen = isGen(s);
      if (gen !== u.running) log(u.name, "reconcile: running flag " + u.running + " -> " + gen);
      u.running = gen;
      if (gen) {
        const lastReal = Math.max(u.lastAct, fmtime(u.file));                      // model activity, or the progress file written by a tool call
        if (!pool.isPaused() && !u.stopping && Date.now() - lastReal > STALL_MS) {
          const n = ++u.stallKicks; u.lastAct = Date.now();
          note("STALL", u.name, "no model activity and no file write for " + Math.round(STALL_MS / 1000) + "s+ (kick " + n + ")");
          if (n >= 3) { await rotate(u, "stalled " + n + " times"); continue; }
          await stop(u); void handle(u, "stall");                                   // stop, wait until it really stopped, THEN send the continue
        }
      } else if (!u.stopping && Date.now() >= u.retryAt && Date.now() - u.lastSend > MIN_GAP) void handle(u, "reconcile: idle");
    }
  } finally { reconciling = false; }
}

// ---- operator commands (from L5): every interruption is stop-then-send
export async function nudge(name: string, text: string) {
  const cmd = /^!(retry|restart)(?!\w)/.exec(text)?.[1]; const body = text.replace(/^!(retry|restart)(?!\w)\s*/, "");
  const targets = name === "ALL" ? live() : live().filter((u) => u.name === name);
  if (!targets.length) { try { fs.mkdirSync(PROG + "/hints", { recursive: true }); const hp = hintPath(name); fs.appendFileSync(hp, (fs.existsSync(hp) ? "\n" : "") + body); note("NUDGE", name, "unit not running: saved as hint"); } catch (e) { log("nudge hint failed", String(e).slice(0, 80)); } return; }
  for (const u of targets) {
    u.noProg = 0; u.intAuto = 0; u.stallKicks = 0; u.consFail = 0; u.retryAt = 0; u.lastSend = 0;
    try {
      const s = await sess(u);
      if (s && isGen(s)) await stop(u);                              // a message to a generating session only queues: stop it first
      if (cmd === "restart" || (cmd === "retry" && !body)) void handle(u, "nudge " + cmd);
      else await send(u, "ORCHESTRATOR NUDGE (read, apply, continue the unit): " + body + " " + RULES);
      note("NUDGE", u.name, (cmd ?? "message") + ": " + body.slice(0, 100));
    } catch (e) { log(u.name, "nudge failed", String(e).slice(0, 100)); }
  }
}
export const resetStuck = () => { for (const u of units.values()) { u.noProg = 0; u.consFail = 0; u.retryAt = 0; u.stallKicks = 0; } };
export const status = () => [...units.values()].map((u) => ({ name: u.name, id: u.id, running: u.running, busy: u.busy, done: u.done, stuck: false, idleS: Math.round((Date.now() - u.lastEv) / 1000), actIdleS: Math.round((Date.now() - Math.max(u.lastAct, fmtime(u.file))) / 1000), noProg: u.noProg, stallKicks: u.stallKicks, consFail: u.consFail, ctxK: Math.round(u.ctx / 1000), rotations: (rots.get(u.name) ?? []).length }));
