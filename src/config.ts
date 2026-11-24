import os from "node:os";
import path from "node:path";

/**
 * Absolute paths used by the bridge. Kept in one place so they are easy to
 * audit and override via environment variables if needed.
 */
export const PATHS = {
  /** Directory where OpenCode agent definition files (.md) live. */
  opencodeAgentsDir: process.env.OCMCP_AGENTS_DIR ?? path.join(homeDir(), ".opencode", "agents"),
  /** OpenCode global config (jsonc) where the plugin array lives. */
  opencodeConfigJsonc: process.env.OCMCP_CONFIG_JSONC ?? path.join(homeDir(), ".opencode", "opencode.jsonc"),
  /** Kilo plugin state directory. */
  kiloStoreDir: process.env.OCMCP_KILO_STORE_DIR ?? path.join(homeDir(), ".config", "opencode", "kilo-multi-account"),
  /** Kilo managed accounts file. */
  kiloAccountsPath: process.env.OCMCP_KILO_ACCOUNTS_PATH ?? path.join(homeDir(), ".config", "opencode", "kilo-multi-account", "accounts.json"),
  /** Kilo active-account state file. */
  kiloStatePath: process.env.OCMCP_KILO_STATE_PATH ?? path.join(homeDir(), ".config", "opencode", "kilo-multi-account", "state.json"),
  /** OpenCode auth file where the active kilo provider creds are synced. */
  authJsonPath: process.env.OCMCP_AUTH_JSON_PATH ?? path.join(homeDir(), ".local", "share", "opencode", "auth.json"),
  /** Local task registry for oc_delegate_task / oc_task_status. */
  tasksRegistryPath: process.env.OCMCP_TASKS_REGISTRY ?? path.join(process.cwd(), "tasks.json"),
} as const;

export const KILO_PROVIDER = "kilo";

/** Mask a secret for safe display: first 4 + last 4 chars. Never returns the raw secret. */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

/** Return headers with sensitive values redacted, safe to include in error output. */
export function redactHeaders(headers: Record<string, string> | undefined | null): Record<string, string> {
  const sensitive = new Set(["authorization", "x-api-key", "cookie", "x-opencode-auth", "proxy-authorization"]);
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    out[key] = sensitive.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

/** Redact common secret-bearing substrings from an error message before surfacing it. */
export function redactErrorMessage(message: unknown): string {
  const text = message == null ? "" : String(message);
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9\-._~+/]+=*/g, "Basic [redacted]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[redacted]")
    .replace(/nvapi-[A-Za-z0-9\-_]{20,}/g, "nvapi-[redacted]")
    .replace(/password["']?\s*[:=]\s*["']?([^"'\s,}]+)/gi, "password=[redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?([^"'\s,}]+)/gi, "api_key=[redacted]");
}

/** Workspace allowlist. OCMCP_ALLOWED_DIRECTORIES is a comma-separated list.
 *  When unset/empty, all directories are allowed. */
export function getAllowedDirectories(): string[] | undefined {
  const raw = process.env.OCMCP_ALLOWED_DIRECTORIES;
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isDirectoryAllowed(directory: string): boolean {
  const allowed = getAllowedDirectories();
  if (!allowed || allowed.length === 0) return true;
  const normalized = normalizeDir(directory);
  return allowed.some((d) => {
    const nd = normalizeDir(d);
    return normalized === nd || normalized.startsWith(nd + "/");
  });
}

function normalizeDir(d: string): string {
  return d.replace(/\\/g, "/").replace(/\/+$/, "");
}

function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** Parse a model reference string into { id, providerID, variant? }.
 *  Accepts "providerID/modelID", "providerID:modelID", "providerID/modelID:variant", or a bare model id. */
export function parseModelRef(model: string): { id: string; providerID: string; variant?: string } {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  const colon = trimmed.indexOf(":");
  let splitIdx = -1;
  if (slash !== -1 && (colon === -1 || slash < colon)) splitIdx = slash;
  else if (colon !== -1) splitIdx = colon;

  if (splitIdx !== -1) {
    const providerID = trimmed.slice(0, splitIdx);
    const rest = trimmed.slice(splitIdx + 1);
    const variantColon = rest.indexOf(":");
    if (variantColon !== -1) {
      return { id: rest.slice(0, variantColon), providerID, variant: rest.slice(variantColon + 1) };
    }
    return { id: rest, providerID };
  }
  return { id: trimmed, providerID: trimmed };
}
