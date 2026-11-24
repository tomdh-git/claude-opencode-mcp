import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

/** Candidate paths for opencode-cli.exe on Windows */
export function findOpenCodeCli(): string {
  if (process.env.OPENCODE_CLI_PATH && fs.existsSync(process.env.OPENCODE_CLI_PATH)) {
    return process.env.OPENCODE_CLI_PATH;
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

  // Check Roaming desktop cli dir
  const cliBase = path.join(appData, "ai.opencode.desktop", "cli");
  if (fs.existsSync(cliBase)) {
    try {
      const dirs = fs.readdirSync(cliBase);
      for (const d of dirs.reverse()) {
        const candidate = path.join(cliBase, d, "opencode-cli.exe");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }

  // Check Local desktop resources
  const resCandidate = path.join(localAppData, "Programs", "@opencode-aidesktop", "resources", "opencode-cli.exe");
  if (fs.existsSync(resCandidate)) return resCandidate;

  // Fallback to wrapper or command in PATH
  return "opencode";
}

export interface ServiceState {
  id?: string;
  version?: string;
  url?: string;
  pid?: number;
  password?: string;
}

export function getServiceJsonPath(): string {
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "opencode", "service.json");
}

export function readServiceJson(): ServiceState | null {
  try {
    const p = getServiceJsonPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

export async function isServiceResponsive(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${url.replace(/\/+$/, "")}/doc`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    return res != null && (res.status === 200 || res.status === 401 || res.status === 404);
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures that the OpenCode background service is running in headless mode.
 * If the desktop app is closed and no service is running, it spawns `opencode serve --service`
 * detached and hidden in the background, waiting until the service is responsive.
 */
export async function ensureHeadlessService(): Promise<{ url: string; pid: number; version: string; spawned: boolean }> {
  const current = readServiceJson();
  if (current && current.pid && current.url && isPidAlive(current.pid)) {
    const responsive = await isServiceResponsive(current.url);
    if (responsive) {
      return {
        url: current.url,
        pid: current.pid,
        version: current.version ?? "unknown",
        spawned: false,
      };
    }
  }

  const cliPath = findOpenCodeCli();
  // Spawn opencode serve --service detached and hidden
  const child = spawn(cliPath, ["serve", "--service"], {
    // not detached: on Windows detached = DETACHED_PROCESS (no console), so every console child (python via PyManager) opened its own visible window; windowsHide alone gives a hidden console the children inherit
    detached: false,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  // Poll until service.json is created and responsive (up to 12s)
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const updated = readServiceJson();
    if (updated && updated.pid && updated.url && isPidAlive(updated.pid)) {
      const ok = await isServiceResponsive(updated.url);
      if (ok) {
        return {
          url: updated.url,
          pid: updated.pid,
          version: updated.version ?? "unknown",
          spawned: true,
        };
      }
    }
  }

  throw new Error(`Timed out waiting for OpenCode headless service to start via ${cliPath}`);
}
