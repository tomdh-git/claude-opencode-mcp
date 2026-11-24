// L0 plumbing: config, logging (the one place that prints keeper-compatible lines), the event bus, the opencode client + event stream, and repo-file helpers.
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { getOpenCodeClient, promptSession } from "../src/openCode.ts";
import { store } from "./store.ts";

export const DIR = "C:/Users/Atomi/opencode-mcp-bridge";
export const REPO = "C:/Users/Atomi/Desktop/BlueySenseV2";
export const PROG = REPO + "/docs/progress";
export const SHADOW = !!process.env.SHADOW;                         // shadow: observe + journal only, never act (prompt/interrupt/create/rotate/pump)
export const MAXRUN = Number(process.env.MAXRUN ?? 4);
export const TOPUP = Number(process.env.TOPUP ?? 3);
export const STALL_MS = Number(process.env.STALL_S ?? 240) * 1000;
export const MODEL = { id: "kilo-auto/free", providerID: "kilo" };
export const RULES = "Rules: never ask questions; do NOT spawn subagents (task tool: they hit rate limits); never use tools.rtools.* (use bash with python tools/sigs/*.py and rdis.exe); create/append your progress file after every step; when truly finished set ## NEXT to start with DONE.";
export const NOQ = "Orchestrator: do not ask questions, nobody answers during the run. Choose the most conservative reading of the unit prompt, write the assumption into your progress file as [UNVERIFIED: 0xrva question] if it matters, and continue the unit.";

export const bus = new EventEmitter(); bus.setMaxListeners(50);
export type BusEvents = "unit.finished" | "unit.started" | "queue.changed" | "review.recorded" | "key.rotated" | "keys.exhausted" | "keys.recovered" | "oc.reconnected" | "oc.shutdown";

const nl = String.fromCharCode(10);
/** state change / operator-visible line: journal + keeper.log-style file + stdout (ocd.out is redirected to keeper-run.out by the supervisor, same line formats as the old keeper) */
export function say(...a: any[]) { const l = a.join(" "); store.journal("say", "", l); logf(l); console.log(l); }
export function note(kind: string, who: string, detail: string) { const l = kind + " " + who + " " + detail; store.journal(kind, who, detail); logf(l); console.log(l); }
export function log(...a: any[]) { logf(a.join(" ")); }
function logf(l: string) { try { fs.appendFileSync(DIR + (SHADOW ? "/ocd-shadow.log" : "/ocd.log"), new Date().toISOString() + " " + l + nl); } catch {} }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const readJ = (f: string, d: any) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
export function writeJ(f: string, o: any) { fs.writeFileSync(f + ".tmp", JSON.stringify(o, null, 1)); fs.renameSync(f + ".tmp", f); }

// ---- opencode client (L0). Every mutating call goes through act(): in shadow mode it only journals what it WOULD do.
export const c: any = await getOpenCodeClient();
export async function act<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (SHADOW) { store.journal("would", "", what); return undefined; }
  return fn();
}
export const prompt = (id: string, text: string) => act("prompt " + id, () => promptSession(id, text));

/** the event stream, resubscribed forever. Emits every event to `handler`; signals reconnects on the bus. */
export async function eventLoop(handler: (e: any) => Promise<void> | void) {
  let quick = 0;
  while (true) {
    const t0 = Date.now(); let sub: any;
    try { sub = await c.event.subscribe({}); } catch (err) { say("event subscribe failed, retrying in 3 s: " + String(err).replace(/\s+/g, " ").slice(0, 140)); await sleep(3000); continue; }
    let shutdown = false;
    try {
      for await (const e of sub) {
        try { await handler(e); } catch (err) { log("event handler error", e?.type, String(err).slice(0, 200)); }
        if (e.type === "location.shutdown") { shutdown = true; say("opencode server shutting down: resubscribing in 5 s"); try { await sub.return?.(); } catch {} await sleep(5000); break; }
      }
    } catch (err) { say("event stream error, resubscribing in 3 s: " + String(err).replace(/\s+/g, " ").slice(0, 140)); await sleep(3000); }
    if (Date.now() - t0 < 1000 && ++quick > 5) { say("OCD event stream keeps closing, exiting"); process.exit(3); }
    if (Date.now() - t0 > 10000) quick = 0;
    log("event stream ended, resubscribing");
    bus.emit(shutdown ? "oc.shutdown" : "oc.reconnected");
  }
}

// ---- repo files shared with the python tools (append-only ledger, outputs, hints)
export const isDone = (f: string) => {
  try { const t = fs.readFileSync(f, "utf8"); const m = t.match(/## NEXT\s*\n([\s\S]{0,400})/); return !!m && /^\s*[-:*]?\s*(DONE\b|unit complete|all (steps )?(complete|done))/i.test(m[1]); } catch { return false; }
};
export const openItems = (): Set<string> => { try { return new Set([...fs.readFileSync(REPO + "/docs/RENDER_CHECKLIST.md", "utf8").matchAll(/^- \[ \] (\S+) /gm)].map((m) => "U-E" + m[1])); } catch { return new Set(); } };
const cnt = (f: string, name: string) => { try { return fs.readFileSync(f, "utf8").split(nl).filter((l) => l.trim() === name).length; } catch { return 0; } };
/** unit start: archive the previous output of this item to oc_<name>_rN.md and consume the review that covered it (append-only files; see tools/nextitems.py) */
export function archivePrevOutput(name: string, file: string) {
  try {
    if (fs.existsSync(file)) { let k = 1; while (fs.existsSync(`${PROG}/oc_${name}_r${k}.md`)) k++; fs.renameSync(file, `${PROG}/oc_${name}_r${k}.md`); log("archived previous output of", name, "-> _r" + k); }
    const net = cnt(PROG + "/reviewed.txt", name) - cnt(PROG + "/reviewed.consumed.txt", name);
    if (net > 0) { fs.appendFileSync(PROG + "/reviewed.consumed.txt", (name + nl).repeat(net)); log("review consumed for", name, "x" + net); }
  } catch (e) { log("archivePrevOutput failed", name, String(e).slice(0, 100)); }
}
export const hintPath = (name: string) => PROG + "/hints/" + name.replace(/^U-E/, "") + ".txt";

/** one place that creates a unit session (used by the scheduler's refill and by the runner's context rotation) */
export async function newSession(title: string): Promise<string> {
  const s: any = await c.session.create({ title, agent: "general", model: { id: MODEL.id, providerID: MODEL.providerID, variant: "default" }, location: { directory: REPO } });
  const sid = s.id ?? s.session?.id;
  await c.session.switchModel({ sessionID: sid, model: MODEL });
  return sid;
}
export const fmtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
