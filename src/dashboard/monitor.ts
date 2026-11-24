import { EventEmitter } from "node:events";
import { getOpenCodeClient } from "../openCode.js";
import { loadKiloState } from "../kilo.js";
import { readServiceJson, isPidAlive } from "../headless.js";

export type CoreStage =
  | "IDLE"
  | "FETCH"
  | "DISPATCH"
  | "EXECUTING"
  | "TOOL_EXEC"
  | "STALLED"
  | "RETIRED"
  | "FAULT"
  | "INTERRUPTED";

export interface StallHazard {
  type: "QUOTA_429" | "ZERO_PROGRESS" | "TOOL_HANG" | "QUESTION_WAIT" | "PERMISSION_WAIT";
  reason: string;
  since: number;
  elapsedSec: number;
  recommendedAction: string;
  details?: Record<string, unknown>;
}

export interface FactualEvent {
  id: string;
  timestamp: number;
  type: string;
  sessionID?: string;
  coreTitle?: string;
  severity: "info" | "warn" | "error" | "success";
  summary: string;
  raw?: unknown;
}

export interface CpuCore {
  coreId: number;
  sessionId: string;
  title: string;
  agent: string;
  model: string;
  directory: string;
  stage: CoreStage;
  subagentOf?: string;
  currentTool?: {
    name: string;
    inputPreview: string;
    startedAt: number;
    elapsedMs: number;
  };
  lastEventTime: number;
  lastTokenTime: number;
  stallHazard: StallHazard | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
  };
  outcome?: string;
  recentEvents: FactualEvent[];
}

export interface CpuStatusReport {
  timestamp: number;
  uptimeSeconds: number;
  service: {
    running: boolean;
    pid?: number;
    url?: string;
    version?: string;
  };
  metrics: {
    activeCores: number;
    stalledCores: number;
    retiredCores: number;
    idleCores: number;
    totalCores: number;
    ipcTokensPerSec: number;
    totalTokens: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
    };
    cacheHitRatio: number;
  };
  kiloPool: {
    activeAccountId?: string;
    totalAccounts: number;
    accountsInCooldown: number;
    coolingUntilMin?: number;
  };
  cores: CpuCore[];
  recentHazards: StallHazard[];
}

class OpenCodeCpuMonitor extends EventEmitter {
  private cores = new Map<string, CpuCore>();
  private globalEvents: FactualEvent[] = [];
  private startTime = Date.now();
  private tokenHistory: Array<{ time: number; tokens: number }> = [];
  private isSubscribed = false;
  private client: any = null;

  constructor() {
    super();
    // Maximum listeners for SSE connections
    this.setMaxListeners(100);
  }

  public async start(): Promise<void> {
    try {
      this.client = await getOpenCodeClient();
      await this.refreshCoresFromApi();
      this.subscribeEvents().catch((err) => {
        console.error("[CpuMonitor] event subscription failed:", err);
      });
      // Start stall watchdog check every 3 seconds
      setInterval(() => this.watchdogCheck(), 3000);
    } catch (err) {
      console.error("[CpuMonitor] Failed to initialize OpenCode client:", err);
    }
  }

  public async refreshCoresFromApi(): Promise<void> {
    if (!this.client) return;
    try {
      const resp = await this.client.session.list({ limit: 40 });
      const sessions = Array.isArray(resp?.data) ? resp.data : [];
      let coreIdx = 0;
      for (const s of sessions) {
        if (!this.cores.has(s.id)) {
          const core: CpuCore = {
            coreId: coreIdx++,
            sessionId: s.id,
            title: s.title || `Session ${s.id.slice(-6)}`,
            agent: s.agent || "default",
            model: s.model ? `${s.model.providerID ?? ""}/${s.model.id ?? ""}` : "unknown",
            directory: s.location?.directory || "",
            stage: this.deriveStageFromOutcome(s.outcome),
            subagentOf: s.parentID,
            lastEventTime: s.time?.updated || s.time?.created || Date.now(),
            lastTokenTime: s.time?.updated || Date.now(),
            stallHazard: null,
            tokens: {
              input: s.tokens?.input ?? 0,
              output: s.tokens?.output ?? 0,
              reasoning: s.tokens?.reasoning ?? 0,
              cacheRead: s.tokens?.cache?.read ?? 0,
            },
            outcome: s.outcome,
            recentEvents: [],
          };
          this.cores.set(s.id, core);
        } else {
          const core = this.cores.get(s.id)!;
          core.title = s.title || core.title;
          core.tokens = {
            input: s.tokens?.input ?? core.tokens.input,
            output: s.tokens?.output ?? core.tokens.output,
            reasoning: s.tokens?.reasoning ?? core.tokens.reasoning,
            cacheRead: s.tokens?.cache?.read ?? core.tokens.cacheRead,
          };
          core.outcome = s.outcome;
          if (core.stage !== "STALLED" && core.stage !== "TOOL_EXEC") {
            core.stage = this.deriveStageFromOutcome(s.outcome);
          }
        }
      }
    } catch (err) {
      console.error("[CpuMonitor] refreshCoresFromApi error:", err);
    }
  }

  private deriveStageFromOutcome(outcome: string | undefined): CoreStage {
    switch (outcome) {
      case "running":
        return "EXECUTING";
      case "succeeded":
      case "completed":
        return "RETIRED";
      case "failed":
        return "FAULT";
      case "interrupted":
        return "INTERRUPTED";
      default:
        return "IDLE";
    }
  }

  private async subscribeEvents(): Promise<void> {
    if (this.isSubscribed || !this.client) return;
    this.isSubscribed = true;

    while (true) {
      try {
        const sub: any = await this.client.event.subscribe({});
        for await (const e of sub) {
          this.handleEvent(e);
        }
      } catch (err) {
        console.error("[CpuMonitor] event stream dropped, reconnecting in 3s...", err);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          this.client = await getOpenCodeClient();
        } catch {}
      }
    }
  }

  private handleEvent(e: any): void {
    const d = e.data ?? {};
    const type = e.type ?? "unknown";
    const sessionId = d.sessionID || e.properties?.sessionID;
    const now = Date.now();

    let core: CpuCore | undefined;
    if (sessionId) {
      core = this.cores.get(sessionId);
      if (!core) {
        core = {
          coreId: this.cores.size,
          sessionId,
          title: `Session ${sessionId.slice(-6)}`,
          agent: "default",
          model: "unknown",
          directory: "",
          stage: "EXECUTING",
          lastEventTime: now,
          lastTokenTime: now,
          stallHazard: null,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
          recentEvents: [],
        };
        this.cores.set(sessionId, core);
      }
      core.lastEventTime = now;
    }

    let severity: FactualEvent["severity"] = "info";
    let summary = `${type}`;

    switch (type) {
      case "session.step.started":
      case "session.execution.started":
        if (core) {
          core.stage = "EXECUTING";
          core.stallHazard = null;
        }
        summary = "Step execution started";
        break;

      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.step.streamed":
        if (core) {
          core.lastTokenTime = now;
          if (core.stage === "STALLED") core.stage = "EXECUTING";
          core.stallHazard = null;
        }
        // Track output token delta for IPC calculation
        this.tokenHistory.push({ time: now, tokens: 1 });
        return; // Don't spam global event log with per-token deltas

      case "session.tool.called":
        if (core) {
          core.stage = "TOOL_EXEC";
          const inputPreview = typeof d.input === "string" ? d.input : JSON.stringify(d.input || {}).slice(0, 100);
          core.currentTool = {
            name: d.name || "tool",
            inputPreview,
            startedAt: now,
            elapsedMs: 0,
          };
        }
        summary = `Tool called: ${d.name ?? "unknown"}`;
        break;

      case "session.tool.success":
        if (core) {
          core.stage = "EXECUTING";
          core.currentTool = undefined;
        }
        severity = "success";
        summary = `Tool finished: ${d.name ?? "tool"}`;
        break;

      case "session.tool.failed":
        if (core) {
          core.stage = "EXECUTING";
          core.currentTool = undefined;
        }
        severity = "warn";
        summary = `Tool failed: ${d.name ?? "tool"} (${JSON.stringify(d.error ?? "")})`;
        break;

      case "session.execution.succeeded":
        if (core) {
          core.stage = "RETIRED";
          core.currentTool = undefined;
          core.stallHazard = null;
          core.outcome = "succeeded";
        }
        severity = "success";
        summary = "Session executed successfully (RETIRED)";
        break;

      case "session.execution.failed":
      case "session.step.failed":
        severity = "error";
        const errStr = JSON.stringify(d.error || d);
        summary = `Execution failed: ${errStr.slice(0, 120)}`;
        if (core) {
          core.stage = "FAULT";
          core.outcome = "failed";
          // Check for rate limit / quota 429
          if (/quota|rate.*limit|429/i.test(errStr)) {
            core.stage = "STALLED";
            core.stallHazard = {
              type: "QUOTA_429",
              reason: `Rate limit / Quota exceeded: ${errStr.slice(0, 150)}`,
              since: now,
              elapsedSec: 0,
              recommendedAction: "Rotate Kilo account or switch provider model",
              details: d,
            };
          }
        }
        break;

      case "session.execution.interrupted":
        if (core) {
          core.stage = "INTERRUPTED";
          core.outcome = "interrupted";
          core.currentTool = undefined;
        }
        severity = "warn";
        summary = "Session execution interrupted";
        break;

      case "form.created":
        if (core) {
          core.stage = "STALLED";
          core.stallHazard = {
            type: "QUESTION_WAIT",
            reason: "Session blocked waiting for user form input",
            since: now,
            elapsedSec: 0,
            recommendedAction: "Submit form response or auto-answer question",
          };
        }
        severity = "warn";
        summary = "Form prompt created (blocked waiting for input)";
        break;

      case "permission.asked":
        if (core) {
          core.stage = "STALLED";
          core.stallHazard = {
            type: "PERMISSION_WAIT",
            reason: `Session blocked asking permission: ${d.resource ?? ""}`,
            since: now,
            elapsedSec: 0,
            recommendedAction: "Approve or reject permission request",
          };
        }
        severity = "warn";
        summary = `Permission requested for ${d.resource ?? ""}`;
        break;

      case "session.usage.updated":
        if (core && d.tokens) {
          core.tokens = {
            input: d.tokens.input ?? core.tokens.input,
            output: d.tokens.output ?? core.tokens.output,
            reasoning: d.tokens.reasoning ?? core.tokens.reasoning,
            cacheRead: d.tokens.cache?.read ?? core.tokens.cacheRead,
          };
        }
        return;
    }

    const eventObj: FactualEvent = {
      id: "ev_" + Math.random().toString(36).slice(2),
      timestamp: now,
      type,
      sessionID: sessionId,
      coreTitle: core?.title,
      severity,
      summary,
      raw: d,
    };

    if (core) {
      core.recentEvents.unshift(eventObj);
      if (core.recentEvents.length > 50) core.recentEvents.pop();
    }

    this.globalEvents.unshift(eventObj);
    if (this.globalEvents.length > 300) this.globalEvents.pop();

    this.emit("event", eventObj);
  }

  /**
   * Watchdog: inspects running cores factually to catch stalls (0-token hang, tool timeout)
   */
  private watchdogCheck(): void {
    const now = Date.now();

    // Prune token history older than 10 seconds for IPC calculation
    this.tokenHistory = this.tokenHistory.filter((t) => now - t.time <= 10000);

    for (const core of this.cores.values()) {
      // Check tool hang (e.g. running for > 35s)
      if (core.stage === "TOOL_EXEC" && core.currentTool) {
        core.currentTool.elapsedMs = now - core.currentTool.startedAt;
        if (core.currentTool.elapsedMs > 35000) {
          core.stage = "STALLED";
          core.stallHazard = {
            type: "TOOL_HANG",
            reason: `Tool '${core.currentTool.name}' executing command for ${Math.round(core.currentTool.elapsedMs / 1000)}s without response`,
            since: core.currentTool.startedAt,
            elapsedSec: Math.round(core.currentTool.elapsedMs / 1000),
            recommendedAction: "Interrupt core or verify running process",
            details: { tool: core.currentTool.name, input: core.currentTool.inputPreview },
          };
        }
      }

      // Check zero-progress stall (marked running/executing, but 0 tokens or events for > 50s)
      if (core.stage === "EXECUTING" && core.outcome === "running") {
        const idleSec = Math.round((now - core.lastTokenTime) / 1000);
        if (idleSec > 50) {
          core.stage = "STALLED";
          core.stallHazard = {
            type: "ZERO_PROGRESS",
            reason: `No token stream or event updates received for ${idleSec}s while marked running`,
            since: core.lastTokenTime,
            elapsedSec: idleSec,
            recommendedAction: "Inspect session messages, check rate limits, or send kick prompt",
          };
        }
      }

      // Update elapsed time on existing stall hazards
      if (core.stallHazard) {
        core.stallHazard.elapsedSec = Math.round((now - core.stallHazard.since) / 1000);
      }
    }
  }

  public async getReport(): Promise<CpuStatusReport> {
    const now = Date.now();
    const serviceInfo = readServiceJson();
    const isServiceRunning = serviceInfo?.pid ? isPidAlive(serviceInfo.pid) : false;

    // Load Kilo pool status
    let kiloPoolData = {
      activeAccountId: undefined as string | undefined,
      totalAccounts: 0,
      accountsInCooldown: 0,
      coolingUntilMin: undefined as number | undefined,
    };

    try {
      const kiloState = await loadKiloState();
      kiloPoolData.activeAccountId = kiloState.state.activeAccountId;
      kiloPoolData.totalAccounts = kiloState.accounts.length;
      let earliestCool = Infinity;
      for (const a of kiloState.accounts) {
        if (a.cooldownUntil && a.cooldownUntil > now) {
          kiloPoolData.accountsInCooldown++;
          if (a.cooldownUntil < earliestCool) earliestCool = a.cooldownUntil;
        }
      }
      if (earliestCool !== Infinity) {
        kiloPoolData.coolingUntilMin = Math.round((earliestCool - now) / 60000);
      }
    } catch {}

    const coresList = Array.from(this.cores.values());
    let activeCount = 0;
    let stalledCount = 0;
    let retiredCount = 0;
    let idleCount = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalReason = 0;
    let totalCache = 0;
    const hazards: StallHazard[] = [];

    for (const c of coresList) {
      if (c.stage === "EXECUTING" || c.stage === "TOOL_EXEC") activeCount++;
      else if (c.stage === "STALLED") stalledCount++;
      else if (c.stage === "RETIRED") retiredCount++;
      else idleCount++;

      totalIn += c.tokens.input;
      totalOut += c.tokens.output;
      totalReason += c.tokens.reasoning;
      totalCache += c.tokens.cacheRead;

      if (c.stallHazard) hazards.push(c.stallHazard);
    }

    // Moving average IPC (tokens/sec across last 10s)
    const tokenCountRecent = this.tokenHistory.reduce((sum, t) => sum + t.tokens, 0);
    const ipcTokensPerSec = Math.round((tokenCountRecent / 10) * 10) / 10;
    const totalProcessed = totalIn + totalCache;
    const cacheHitRatio = totalProcessed > 0 ? Math.round((totalCache / totalProcessed) * 1000) / 10 : 0;

    return {
      timestamp: now,
      uptimeSeconds: Math.round((now - this.startTime) / 1000),
      service: {
        running: isServiceRunning,
        pid: serviceInfo?.pid,
        url: serviceInfo?.url,
        version: serviceInfo?.version,
      },
      metrics: {
        activeCores: activeCount,
        stalledCores: stalledCount,
        retiredCores: retiredCount,
        idleCores: idleCount,
        totalCores: coresList.length,
        ipcTokensPerSec,
        totalTokens: {
          input: totalIn,
          output: totalOut,
          reasoning: totalReason,
          cacheRead: totalCache,
        },
        cacheHitRatio,
      },
      kiloPool: kiloPoolData,
      cores: coresList,
      recentHazards: hazards,
    };
  }

  public getGlobalEvents(): FactualEvent[] {
    return this.globalEvents;
  }

  public getCore(sessionId: string): CpuCore | undefined {
    return this.cores.get(sessionId);
  }
}

export const cpuMonitor = new OpenCodeCpuMonitor();
