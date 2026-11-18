import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS, KILO_PROVIDER, maskSecret } from "./config.js";
import { getOpenCodeClient } from "./openCode.js";

type StoredCreds =
  | { type: "api"; key: string }
  | { type: "oauth"; refresh: string; access: string; expires: number; accountId?: string };

export type ManagedAccount = {
  id: string;
  label?: string;
  enabled: boolean;
  priority: number;
  cooldownUntil?: number;
  lastUsedAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  credentials: StoredCreds;
};

type AccountsFile = { version: number; accounts: ManagedAccount[] };
type StateFile = { version: number; activeAccountId?: string; sessionAccounts?: Record<string, string> };

export type AccountSummary = {
  id: string;
  label?: string;
  type: "api" | "oauth";
  enabled: boolean;
  priority: number;
  active: boolean;
  cooldownUntil?: number;
  cooldownActive: boolean;
  accountId?: string;
  secretHint: string;
  lastUsedAt?: number;
  lastError?: string;
  updatedAt: number;
};

/** Read a JSON file, returning the fallback when missing or invalid. */
async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write JSON to a file (temp file + rename). */
async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function now(): number {
  return Date.now();
}

function credsKey(creds: StoredCreds): string {
  if (creds.type === "api") return `api:${creds.key}`;
  return `oauth:${creds.access}:${creds.accountId ?? ""}`;
}

function isOAuth(creds: StoredCreds): creds is Extract<StoredCreds, { type: "oauth" }> {
  return creds.type === "oauth";
}

function summarizeAccount(account: ManagedAccount, activeId?: string): AccountSummary {
  const creds = account.credentials;
  const cooldownActive = !!account.cooldownUntil && account.cooldownUntil > now();
  return {
    id: account.id,
    label: account.label,
    type: creds.type,
    enabled: account.enabled,
    priority: account.priority,
    active: account.id === activeId,
    cooldownUntil: account.cooldownUntil,
    cooldownActive,
    accountId: isOAuth(creds) ? creds.accountId : undefined,
    secretHint: isOAuth(creds) ? maskSecret(creds.access) : maskSecret(creds.key),
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    updatedAt: account.updatedAt,
  };
}

/** Load both kilo state files, ensuring the store directory exists. */
export async function loadKiloState(): Promise<{ accounts: ManagedAccount[]; state: StateFile }> {
  await fs.mkdir(PATHS.kiloStoreDir, { recursive: true });
  const accountsFile = (await readJsonFile<AccountsFile>(PATHS.kiloAccountsPath, { version: 1, accounts: [] }));
  const stateFile = (await readJsonFile<StateFile>(PATHS.kiloStatePath, { version: 1 }));
  const accounts = Array.isArray(accountsFile.accounts) ? accountsFile.accounts : [];
  const state = stateFile && typeof stateFile === "object" ? stateFile : { version: 1 };
  if (!state.sessionAccounts) state.sessionAccounts = {};
  return { accounts, state };
}

export async function persistKiloState(accounts: ManagedAccount[], state: StateFile): Promise<void> {
  await fs.mkdir(PATHS.kiloStoreDir, { recursive: true });
  await writeJsonFile(PATHS.kiloAccountsPath, { version: 1, accounts } satisfies AccountsFile);
  await writeJsonFile(PATHS.kiloStatePath, state satisfies StateFile);
}

/** Sync the active account's credentials into OpenCode's auth.json under the "kilo" key. */
export async function syncActiveAuthToAuthJson(accounts: ManagedAccount[], state: StateFile): Promise<void> {
  const activeId = state.activeAccountId;
  const active = activeId ? accounts.find((a) => a.id === activeId) : undefined;
  if (!active) return;

  const payload =
    active.credentials.type === "api"
      ? { type: "api", key: active.credentials.key }
      : {
          type: "oauth",
          refresh: active.credentials.refresh,
          access: active.credentials.access,
          expires: active.credentials.expires,
          ...(active.credentials.accountId ? { accountId: active.credentials.accountId } : {}),
        };

  const next = { [KILO_PROVIDER]: payload };
  await fs.mkdir(path.dirname(PATHS.authJsonPath), { recursive: true });
  // Read existing auth.json to preserve other providers, then set/replace "kilo".
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(PATHS.authJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    current = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    current = {};
  }
  await writeJsonFile(PATHS.authJsonPath, { ...current, [KILO_PROVIDER]: payload });
}

/** Masked status view of the kilo multi-account state. */
export async function kiloStatus(): Promise<{ activeAccountId?: string; accounts: AccountSummary[] }> {
  const { accounts, state } = await loadKiloState();
  const activeId = state.activeAccountId;
  return {
    activeAccountId: activeId,
    accounts: [...accounts]
      .sort((a, b) => a.priority - b.priority)
      .map((a) => summarizeAccount(a, activeId)),
  };
}

/** Raw (secret-masked) account listing. Secrets are never returned in plaintext. */
export async function kiloListAccounts(): Promise<{ activeAccountId?: string; accounts: AccountSummary[] }> {
  return kiloStatus();
}

/** Switch the active kilo account, clear its cooldown, and persist state + auth.json. */
export async function kiloSwitchAccount(accountId: string): Promise<{ accountId: string; active: boolean; liveActivated?: boolean }> {
  const { accounts, state } = await loadKiloState();
  const target = accounts.find((a) => a.id === accountId);
  if (!target) throw new Error(`Kilo account not found: ${accountId}`);
  if (!target.enabled) throw new Error(`Kilo account is disabled: ${accountId}`);

  state.activeAccountId = accountId;
  target.cooldownUntil = undefined;
  target.lastError = undefined;
  target.lastUsedAt = now();
  target.updatedAt = now();

  await persistKiloState(accounts, state);
  await syncActiveAuthToAuthJson(accounts, state);
  const live = await activateInOpenCode(target);

  return { accountId: target.id, active: true, liveActivated: live };
}

/** Make the running OpenCode service use this account: OpenCode keeps its own credential store
 *  (credential.list/activate) and ignores auth.json while running, so match by key and activate. */
export async function activateInOpenCode(account: ManagedAccount): Promise<boolean> {
  if (account.credentials.type !== "api") return false;
  try {
    const client: any = await getOpenCodeClient();
    const list: any[] = await client.credential.list();
    const hit = list.find((c) => c.integrationID === KILO_PROVIDER && c.value?.key === (account.credentials as any).key);
    if (!hit) {
      await client.credential.create({
        integrationID: KILO_PROVIDER,
        label: account.label ?? "Kilo (bridge)",
        value: { type: "key", key: (account.credentials as any).key },
        activate: true,
      });
      return true;
    }
    if (!hit.active) await client.credential.activate({ credentialID: hit.id });
    return true;
  } catch {
    return false;
  }
}

/** Mark the active account rate-limited (cooldown) and switch to the next enabled account not in cooldown. */
export async function kiloRotate(cooldownMs = 60 * 60 * 1000): Promise<{ from?: string; to?: string; liveActivated: boolean }> {
  const { accounts, state } = await loadKiloState();
  const cur = accounts.find((a) => a.id === state.activeAccountId);
  if (cur) {
    cur.cooldownUntil = now() + cooldownMs;
    cur.lastError = "rate limit (rotated)";
    cur.updatedAt = now();
  }
  const next = [...accounts]
    .sort((a, b) => a.priority - b.priority)
    .find((a) => a.enabled && a.id !== cur?.id && !(a.cooldownUntil && a.cooldownUntil > now()));
  if (!next) {
    await persistKiloState(accounts, state);
    throw new Error("All Kilo accounts are in cooldown");
  }
  state.activeAccountId = next.id;
  next.lastUsedAt = now();
  await persistKiloState(accounts, state);
  await syncActiveAuthToAuthJson(accounts, state);
  return { from: cur?.id, to: next.id, liveActivated: await activateInOpenCode(next) };
}

/** Add an API-key kilo account. Appends to accounts.json and syncs auth.json if it becomes active. */
export async function kiloAddAccount(key: string, label?: string): Promise<{
  accountId: string;
  active: boolean;
  added: boolean;
}> {
  if (!key || !key.trim()) throw new Error("kilo_add_account requires a non-empty key");
  const trimmedKey = key.trim();

  const { accounts, state } = await loadKiloState();
  const existing = accounts.find((a) => a.credentials.type === "api" && a.credentials.key === trimmedKey);
  let account: ManagedAccount;
  let added: boolean;

  if (existing) {
    account = existing;
    added = false;
    if (label && !account.label) account.label = label;
    account.updatedAt = now();
  } else {
    account = {
      id: randomUUID(),
      label: label ?? "Kilo API key",
      enabled: true,
      priority: accounts.length,
      createdAt: now(),
      updatedAt: now(),
      credentials: { type: "api", key: trimmedKey },
    };
    accounts.push(account);
    added = true;
  }

  // Set active if no account is active yet.
  if (!state.activeAccountId) {
    state.activeAccountId = account.id;
  }
  account.lastUsedAt = now();
  account.updatedAt = now();

  await persistKiloState(accounts, state);
  await syncActiveAuthToAuthJson(accounts, state);

  return { accountId: account.id, active: state.activeAccountId === account.id, added };
}

/** Clear cooldown (and lastError) for one account or all accounts. */
export async function kiloClearCooldown(accountId?: string): Promise<{
  cleared: number;
  activeAccountId?: string;
}> {
  const { accounts, state } = await loadKiloState();
  const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  if (accountId && targets.length === 0) throw new Error(`Kilo account not found: ${accountId}`);
  let cleared = 0;
  for (const a of targets) {
    if (a.cooldownUntil !== undefined || a.lastError !== undefined) {
      a.cooldownUntil = undefined;
      a.lastError = undefined;
      a.updatedAt = now();
      cleared++;
    }
  }
  await persistKiloState(accounts, state);
  return { cleared, activeAccountId: state.activeAccountId };
}
