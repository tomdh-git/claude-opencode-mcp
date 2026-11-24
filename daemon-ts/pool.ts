// L1 provider pool: the single owner of Kilo key state. Knows nothing about units. Talks to the rest only through the bus:
//   key.rotated {label}   keys.exhausted   keys.recovered
// Health = a REAL tiny chat request per key (2xx only). Rotation = probe the next keys in order, activate the first that answers; if none does, `paused` until a re-probe succeeds.
import fs from "node:fs";
import { loadKiloState, kiloSwitchAccount } from "../src/kilo.ts";
import { bus, say, log, act, SHADOW, DIR, MODEL } from "./core.ts";
import { store } from "./store.ts";

const URL_ = "https://api.kilo.ai/api/gateway/chat/completions";
const RETRY_MS = 90 * 1000, AUDIT_MS = 15 * 60000, DEAD_MS = 120000;
type K = { id: string; label: string; key: string; coolUntil: number; fails: number };
const pool = new Map<string, K>();
let paused = false, switchedAt = 0, wake: any = null, picking = false, lastAudit = 0;
export const isPaused = () => paused;

async function refresh() {
  const st: any = await loadKiloState();
  for (const a of st.accounts) if (a.credentials.type === "api" && a.enabled && !pool.has(a.label)) pool.set(a.label, { id: a.id, label: a.label, key: a.credentials.key, coolUntil: 0, fails: 0 });
  return st;
}
async function currentLabel() { const st: any = await loadKiloState(); return st.accounts.find((a: any) => a.id === st.state?.activeAccountId)?.label as string | undefined; }
async function probe(k: K): Promise<number> {
  try {
    const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + k.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "hi" }], max_tokens: 3 }), signal: AbortSignal.timeout(25000) });
    await r.text(); store.saveKey(k.label, k.coolUntil, k.fails, r.status); return r.status;
  } catch { store.saveKey(k.label, k.coolUntil, k.fails, 0); return 0; }
}
/** probe keys in order after `after`; activate the first that answers 2xx. Returns false (and pauses) when none does. */
export async function pick(after?: string): Promise<boolean> {
  if (picking) return !paused; picking = true;
  try {
    await refresh();
    const all = [...pool.values()]; const i = all.findIndex((k) => k.label === after);
    for (const k of [...all.slice(i + 1), ...all.slice(0, i + 1)]) {
      const st = await probe(k);
      if (st >= 200 && st < 300) {
        k.fails = 0; k.coolUntil = 0;
        if (!SHADOW) await kiloSwitchAccount(k.id);
        switchedAt = Date.now(); const was = paused; paused = false;
        say("KEY active " + k.label + " (probe ok)"); bus.emit("key.rotated", k.label); if (was) bus.emit("keys.recovered");
        return true;
      }
      k.fails++; k.coolUntil = Date.now() + DEAD_MS;
    }
    paused = true; clearTimeout(wake); wake = setTimeout(() => void recover(), RETRY_MS);
    say("ALL KEYS COOLING: every key failed a real probe, units paused, re-probing every 90 s");
    bus.emit("keys.exhausted"); return false;
  } finally { picking = false; }
}
async function recover() { wake = null; await pick(); }
/** a unit hit a quota/rate error (or the watchdog asked): rotate off the active key. Debounced: failures within 8 s of a switch belong to the old key. */
export async function onQuota(why: string, force = false) {
  if (fs.existsSync(DIR + "/norotate")) return;
  if (!force && Date.now() - switchedAt < 8000) return;
  await refresh(); const cl = await currentLabel(); if (!cl) return;
  say("KEY " + cl + " hit the limit (" + why + "): probe for a working key (running units are not interrupted)");
  await pick(cl);
}
/** audit every key with a real request; rotate if the ACTIVE one is bad. Writes watchdog-keys.json (compat). */
export async function audit(reason: string) {
  lastAudit = Date.now(); await refresh(); const st: any = await loadKiloState(); const res: any[] = [];
  for (const a of st.accounts) { if (a.credentials?.type !== "api" || !a.enabled) continue; const k = pool.get(a.label); if (!k) continue; const s = await probe(k); res.push({ label: a.label, id: a.id, status: s, ok: s >= 200 && s < 300 }); }
  const summary = res.map((r) => r.label + (r.ok ? ":ok" : ":" + r.status)).join(" ");
  log("key audit (" + reason + "): " + summary);
  try { fs.writeFileSync(DIR + "/watchdog-keys.json", JSON.stringify({ at: new Date().toISOString(), reason, activeId: st.state?.activeAccountId, results: res })); } catch {}
  const active = res.find((r) => r.id === st.state?.activeAccountId);
  if (!res.some((r) => r.ok)) { say("WATCHDOG ALL KEYS DOWN " + summary); return; }
  if (active && !active.ok && !paused) await onQuota("audit: active key failed", true);
}
export const auditDue = () => Date.now() - lastAudit > AUDIT_MS;
export async function init(initCoolMin = 0) { await refresh(); if (initCoolMin > 0) for (const k of pool.values()) k.coolUntil = Date.now() + initCoolMin * 60000; await pick(); }
export const summary = () => ({ paused, keys: store.keys() });
