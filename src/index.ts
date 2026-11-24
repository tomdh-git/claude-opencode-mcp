import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import {
  getOpenCodeClient,
  listSessions,
  createSession,
  getSession,
  switchModel,
  switchAgent,
  interruptSession,
  deleteSession,
  promptSession,
  listAgents,
  sanitizeOpenCodeError,
  OpenCodeConnectionError,
} from "./openCode.js";
import { kiloStatus, kiloListAccounts, kiloSwitchAccount, kiloAddAccount, kiloClearCooldown, kiloRotate } from "./kilo.js";
import { taskRegistry, type TaskStatus } from "./tasks.js";
import { PATHS, isDirectoryAllowed, parseModelRef, redactErrorMessage, maskDirectory } from "./config.js";
import { startDashboardServer, getDashboardUrl, getUiHtml } from "./dashboard/server.js";
import { cpuMonitor } from "./dashboard/monitor.js";
import { formatSessionMessages } from "./dashboard/render.js";
import { renderCpuTuiComponent, renderSessionTuiComponent } from "./dashboard/tui.js";
import { ensureHeadlessService, readServiceJson, isPidAlive } from "./headless.js";

const AGENTS_DIR = PATHS.opencodeAgentsDir;

/** Wrap a successful value as an MCP tool text result. */
function jsonResult(data: unknown): CallToolResult {
  const content: { type: "text"; text: string }[] = [{ type: "text", text: JSON.stringify(data, null, 2) }];
  return { content };
}

/** Build an MCP error result (surfaced as isError by the SDK). */
function errResult(message: unknown): CallToolResult {
  const content: { type: "text"; text: string }[] = [{ type: "text", text: String(redactErrorMessage(message)) }];
  return { content, isError: true };
}

/** Handler wrapper: catches errors, redacts secrets, returns MCP result. */
async function toolHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<unknown>,
  ...args: T
): Promise<CallToolResult> {
  try {
    const data = await fn(...args);
    return jsonResult(data);
  } catch (err) {
    if (err instanceof OpenCodeConnectionError) return errResult(err.message);
    return errResult(sanitizeOpenCodeError(err).message);
  }
}

/* ------------------------------------------------------------------ */
/* Agent file helpers                                                 */
/* ------------------------------------------------------------------ */

function safeAgentFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function yamlScalar(v: string): string {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeAgentFile(name: string, fields: { model?: string; permission?: string; instructions: string }): string {
  const fileName = `${safeAgentFileName(name)}.md`;
  const filePath = path.join(AGENTS_DIR, fileName);
  const indented = fields.instructions.split("\n").map((line) => (line ? "  " + line : "")).join("\n");
  const content = [
    "---",
    `name: ${yamlScalar(name)}`,
    `model: ${yamlScalar(fields.model ?? "")}`,
    `permission: ${yamlScalar(fields.permission ?? "allow")}`,
    "instructions: |",
    indented,
    "---",
    "",
  ].join("\n");
  fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  fs.writeFile(filePath, content, "utf8").catch(() => {});
  return filePath;
}

function parseAgentFrontmatter(content: string): { name?: string; model?: string; permission?: string; instructions?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = match?.[1] ?? "";
  const out: Record<string, string> = {};
  const lines = frontmatter.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1]!;
    let value = kv[2] ?? "";
    if (key === "instructions" && value.trim() === "|") {
      const block: string[] = [];
      i++;
      while (i < lines.length) {
        const blockLine = lines[i];
        if (!blockLine || !blockLine.startsWith("  ")) break;
        block.push(blockLine.slice(2));
        i++;
      }
      out.instructions = block.join("\n");
      continue;
    }
    let v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[key] = v;
    i++;
  }
  return {
    name: out.name || undefined,
    model: out.model || undefined,
    permission: out.permission || undefined,
    instructions: out.instructions || undefined,
  };
}

async function listFileAgents(): Promise<Array<{ name?: string; model?: string; permission?: string; instructions?: string; source: string; filePath: string }>> {
  let files: string[];
  try {
    files = await fs.readdir(AGENTS_DIR);
  } catch {
    return [];
  }
  const result: Array<{ name?: string; model?: string; permission?: string; instructions?: string; source: string; filePath: string }> = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, f);
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    const parsed = parseAgentFrontmatter(content);
    result.push({ ...parsed, source: "file", filePath });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Task status mapping                                                */
/* ------------------------------------------------------------------ */

function mapSessionOutcome(outcome: string | undefined): TaskStatus {
  switch (outcome) {
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    default: return "running";
  }
}

function summarizeLastEvents(messages: unknown[]): Array<{ id?: string; type?: string; summary?: string }> {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 10).map((m) => {
    if (m && typeof m === "object") {
      const msg = m as Record<string, unknown>;
      return {
        id: (msg.id as string | undefined),
        type: (msg.type as string | undefined),
        summary: String(msg.content ?? msg.text ?? "").slice(0, 120),
      };
    }
    return { summary: String(m) };
  });
}

/* ------------------------------------------------------------------ */
/* Build the MCP server                                               */
/* ------------------------------------------------------------------ */

export async function runStdioServer(): Promise<void> {
  const server = new McpServer({
    name: "claude-opencode-mcp",
    version: "1.0.0",
  });

  /* ============ Session management ============ */

  server.registerTool(
    "oc_create_session",
    {
      description: "Create a new OpenCode session in a directory.",
      inputSchema: z.object({
        directory: z.string().describe("Working directory for the session"),
        title: z.string().optional().describe("Session title"),
        agent: z.string().optional().describe("Agent name to bind"),
        model: z.string().optional().describe("Model reference, e.g. providerID/modelID"),
      }),
    },
    async (args) => {
      if (!isDirectoryAllowed(args.directory)) {
        return errResult(`Directory not allowed by workspace allowlist: ${args.directory}`);
      }
      const data = await createSession({
        directory: args.directory,
        title: args.title,
        agent: args.agent,
        model: args.model,
      });
      return jsonResult({ ok: true, session: data });
    },
  );

  server.registerTool(
    "oc_list_sessions",
    {
      description: "List OpenCode sessions.",
      inputSchema: z.object({
        limit: z.number().optional(),
        order: z.enum(["asc", "desc"]).optional(),
        search: z.string().optional(),
        parentID: z.string().optional().nullable(),
        archived: z.boolean().optional(),
        directory: z.string().optional(),
        project: z.string().optional(),
        subpath: z.string().optional(),
        cursor: z.string().optional(),
      }),
    },
    async (args) => toolHandler(listSessions, args),
  );

  server.registerTool(
    "oc_get_session",
    {
      description: "Get a session and its recent messages.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
      }),
    },
    async (args) => {
      const data = await getSession(args.sessionID);
      return jsonResult(data);
    },
  );

  server.registerTool(
    "oc_switch_model",
    {
      description: "Switch the model of a session.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
        model: z.string().describe("Model reference, e.g. providerID/modelID"),
      }),
    },
    async (args) => {
      await switchModel(args.sessionID, args.model);
      return jsonResult({ ok: true, sessionID: args.sessionID, model: args.model });
    },
  );

  server.registerTool(
    "oc_switch_agent",
    {
      description: "Switch the agent of a session.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
        agent: z.string().describe("Agent name"),
      }),
    },
    async (args) => {
      await switchAgent(args.sessionID, args.agent);
      return jsonResult({ ok: true, sessionID: args.sessionID, agent: args.agent });
    },
  );

  server.registerTool(
    "oc_interrupt_session",
    {
      description: "Interrupt a running session.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
      }),
    },
    async (args) => {
      const data = await interruptSession(args.sessionID);
      return jsonResult({ ok: true, sessionID: args.sessionID, result: data });
    },
  );

  server.registerTool(
    "oc_delete_session",
    {
      description: "Delete a session.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
      }),
    },
    async (args) => {
      await deleteSession(args.sessionID);
      return jsonResult({ ok: true, sessionID: args.sessionID });
    },
  );

  /* ============ Agent / subagent management ============ */

  server.registerTool(
    "oc_create_agent",
    {
      description: "Write an OpenCode agent definition file to .opencode/agents/<name>.md.",
      inputSchema: z.object({
        name: z.string().describe("Agent name (used for filename)"),
        instructions: z.string().describe("Agent system instructions"),
        model: z.string().optional().describe("Default model reference"),
        permission: z.string().optional().describe("Permission ruleset name, e.g. allow"),
      }),
    },
    async (args) => {
      if (!args.name.trim()) return errResult("Agent name must not be empty");
      const filePath = writeAgentFile(args.name.trim(), {
        model: args.model,
        permission: args.permission,
        instructions: args.instructions,
      });
      return jsonResult({ ok: true, name: args.name.trim(), path: maskDirectory(filePath) });
    },
  );

  server.registerTool(
    "oc_create_subagent",
    {
      description: "Create a child session bound to an agent and send an initial prompt.",
      inputSchema: z.object({
        parentSessionID: z.string().describe("Parent session ID"),
        agent: z.string().describe("Agent name to bind to the child"),
        instructions: z.string().describe("Initial prompt/instructions for the subagent"),
      }),
    },
    async (args) => {
      const client = await getOpenCodeClient();
      // Learn the parent's directory so the child runs in the same workspace.
      let directory: string | undefined;
      try {
        const parent = await client.session.get({ sessionID: args.parentSessionID });
        directory = (parent as any)?.location?.directory;
      } catch {
        directory = undefined;
      }
      if (!directory) directory = process.cwd();
      if (!isDirectoryAllowed(directory)) {
        return errResult(`Directory not allowed by workspace allowlist: ${directory}`);
      }
      const created = await client.session.create({
        title: `Subagent of ${args.parentSessionID}`,
        agent: args.agent,
        model: null,
        location: { directory },
        parentID: args.parentSessionID,
      });
      const child = created as { id: string };
      await client.session.prompt({ sessionID: child.id, text: args.instructions });
      return jsonResult({ ok: true, sessionId: child.id, parentSessionID: args.parentSessionID, agent: args.agent });
    },
  );

  server.registerTool(
    "oc_list_agents",
    {
      description: "List OpenCode agents (file-based .opencode/agents + API).",
      inputSchema: z.object({
        directory: z.string().optional().describe("Directory scope for API agent list"),
      }),
    },
    async (args) => {
      const [fileAgents, apiAgents] = await Promise.all([
        listFileAgents(),
        (async () => {
          try {
            return await listAgents({ directory: args.directory });
          } catch {
            return { data: [] };
          }
        })(),
      ]);
      return jsonResult({ agents: fileAgents, api: apiAgents });
    },
  );

  /* ============ Kilo account management ============ */

  server.registerTool(
    "kilo_status",
    {
      description: "Show Kilo multi-account plugin status (active account, cooldowns, masked secrets).",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await kiloStatus();
      return jsonResult(data);
    },
  );

  server.registerTool(
    "kilo_list_accounts",
    {
      description: "List managed Kilo accounts as JSON (secrets masked).",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await kiloListAccounts();
      return jsonResult(data);
    },
  );

  server.registerTool(
    "kilo_rotate",
    {
      description: "Put the active Kilo account on cooldown (rate-limited) and switch to the next available account, activating it live in OpenCode.",
      inputSchema: z.object({ cooldownMinutes: z.number().optional() }),
    },
    async (args) => jsonResult({ ok: true, ...(await kiloRotate((args.cooldownMinutes ?? 60) * 60000)) }),
  );

  server.registerTool(
    "kilo_switch_account",
    {
      description: "Switch the active Kilo account, clear its cooldown, and sync auth.json.",
      inputSchema: z.object({
        accountId: z.string().describe("Kilo managed account ID"),
      }),
    },
    async (args) => {
      const data = await kiloSwitchAccount(args.accountId);
      return jsonResult({ ok: true, ...data });
    },
  );

  server.registerTool(
    "kilo_add_account",
    {
      description: "Add a Kilo API key account to the managed pool.",
      inputSchema: z.object({
        key: z.string().describe("Kilo API key (masked in output)"),
        label: z.string().optional().describe("Optional label"),
      }),
    },
    async (args) => {
      const data = await kiloAddAccount(args.key, args.label);
      return jsonResult({ ok: true, accountId: data.accountId, active: data.active, added: data.added });
    },
  );

  server.registerTool(
    "kilo_clear_cooldown",
    {
      description: "Clear cooldown/rate-limit state for one Kilo account or all accounts.",
      inputSchema: z.object({
        accountId: z.string().optional().describe("Account ID; omit to clear all"),
      }),
    },
    async (args) => {
      const data = await kiloClearCooldown(args.accountId);
      return jsonResult({ ok: true, ...data });
    },
  );

  /* ============ Orchestration ============ */

  server.registerTool(
    "oc_delegate_task",
    {
      description: "Delegate a task: create a session, bind agent/model, send instructions, register the task.",
      inputSchema: z.object({
        directory: z.string().describe("Working directory"),
        instructions: z.string().describe("Task instructions / prompt"),
        agent: z.string().optional().describe("Agent name to bind"),
        model: z.string().optional().describe("Model reference"),
      }),
    },
    async (args) => {
      if (!isDirectoryAllowed(args.directory)) {
        return errResult(`Directory not allowed by workspace allowlist: ${args.directory}`);
      }
      const client = await getOpenCodeClient();
      const model = args.model ? parseModelRef(args.model) : undefined;
      const created = await client.session.create({
        title: `Task: ${args.instructions.slice(0, 60)}`,
        agent: args.agent ?? null,
        model: model ? { id: model.id, providerID: model.providerID, variant: model.variant } : null,
        location: { directory: args.directory },
      });
      const session = created as { id: string };
      await client.session.prompt({ sessionID: session.id, text: args.instructions });

      const task = await taskRegistry.create({
        directory: args.directory,
        instructions: args.instructions,
        agent: args.agent,
        model: args.model,
        status: "created",
        sessionId: session.id,
      });

      return jsonResult({ ok: true, taskId: task.taskId, sessionId: session.id, status: "created" });
    },
  );

  server.registerTool(
    "oc_task_status",
    {
      description: "Check the status of a delegated task via its session.",
      inputSchema: z.object({
        taskId: z.string().describe("Task ID returned by oc_delegate_task"),
      }),
    },
    async (args) => {
      const task = await taskRegistry.get(args.taskId);
      if (!task) return errResult(`Task not found: ${args.taskId}`);

      let status: TaskStatus = task.status;
      let result: string | undefined;
      let blockingReason: string | undefined;
      let lastEvents: Array<{ id?: string; type?: string; summary?: string }> = [];

      if (task.sessionId) {
        try {
          const client = await getOpenCodeClient();
          const [session, messages] = await Promise.all([
            client.session.get({ sessionID: task.sessionId }),
            client.message.list({ sessionID: task.sessionId, limit: 10, order: "desc" }),
          ]);
          const info = session as Record<string, unknown>;
          const outcome = info.outcome as string | undefined;
          status = mapSessionOutcome(outcome);
          lastEvents = summarizeLastEvents((messages as unknown as unknown[]) ?? []);

          if (outcome === "succeeded") {
            result = "Session completed successfully";
          } else if (outcome === "failed") {
            blockingReason = "Session failed";
            if (!(task as any).rotated) {
              try {
                const rot = await kiloRotate();
                blockingReason = `Session failed (assumed rate limit); auto-rotated Kilo account, live=${rot.liveActivated}. Re-delegate the unit.`;
                await taskRegistry.update(args.taskId, { rotated: true } as any);
              } catch (e) { blockingReason = `Session failed; rotate failed: ${String(e)}`; }
            }
          } else if (outcome === "interrupted") {
            blockingReason = "Session was interrupted";
          }
        } catch {
          // Session may not be reachable yet; keep registry status.
          lastEvents = [];
        }
      }

      await taskRegistry.update(args.taskId, { status, lastEvents: lastEvents.map((e) => JSON.stringify(e)) as unknown as string[] });

      return jsonResult({
        status,
        taskId: args.taskId,
        sessionId: task.sessionId,
        lastEvents,
        result,
        blockingReason,
        directory: task.directory,
      });
    },
  );

  /* ============ CPU Dashboard & Headless Telemetry ============ */

  // Register MCP Apps UI resource for native embedded rendering inside Claude
  server.registerResource(
    "cpu_dashboard_ui",
    "ui://opencode/cpu-dashboard",
    {
      mimeType: "text/html;profile=mcp-app",
      description: "OpenCode CPU Architecture & Co-processor Telemetry Component",
      _meta: { ui: { csp: { connectDomains: ["http://localhost:4040", "http://127.0.0.1:4040"], resourceDomains: [] } } },
    },
    async () => ({
      contents: [
        {
          uri: "ui://opencode/cpu-dashboard",
          mimeType: "text/html;profile=mcp-app",
          text: getUiHtml(),
          _meta: { ui: { csp: { connectDomains: ["http://localhost:4040", "http://127.0.0.1:4040"], resourceDomains: [] } } },
        },
      ],
    }),
  );

  server.registerTool(
    "oc_open_dashboard",
    {
      description: "Render the OpenCode CPU status dashboard GUI component directly inside Claude Code without opening the external browser.",
      inputSchema: z.object({}),
      _meta: {
        ui: {
          resourceUri: "ui://opencode/cpu-dashboard",
        },
      },
    },
    async () => {
      const report = await cpuMonitor.getReport();
      const tui = renderCpuTuiComponent(report);
      const uiHtml = getUiHtml();

      const content: CallToolResult["content"] = [
        { type: "text", text: tui },
        {
          type: "resource",
          resource: {
            uri: "ui://opencode/cpu-dashboard",
            mimeType: "text/html;profile=mcp-app",
            text: uiHtml,
          },
        },
      ];

      return {
        content,
        _meta: {
          ui: {
            resourceUri: "ui://opencode/cpu-dashboard",
          },
        },
      };
    },
  );

  server.registerTool(
    "oc_cpu_status",
    {
      description: "Render factual telemetry on OpenCode execution cores, pipeline metrics, and stall hazards directly inside Claude Code.",
      inputSchema: z.object({}),
      _meta: {
        ui: {
          resourceUri: "ui://opencode/cpu-dashboard",
        },
      },
    },
    async () => {
      const report = await cpuMonitor.getReport();
      const tui = renderCpuTuiComponent(report);
      const uiHtml = getUiHtml();

      const content: CallToolResult["content"] = [
        { type: "text", text: tui },
        {
          type: "resource",
          resource: {
            uri: "ui://opencode/cpu-dashboard",
            mimeType: "text/html;profile=mcp-app",
            text: uiHtml,
          },
        },
      ];

      return {
        content,
        _meta: {
          ui: {
            resourceUri: "ui://opencode/cpu-dashboard",
          },
        },
      };
    },
  );

  server.registerTool(
    "oc_service_status",
    {
      description: "Check or ensure the OpenCode headless background service status, PID, port, and version.",
      inputSchema: z.object({
        ensureRunning: z.boolean().optional().describe("If true, proactively start the headless service if not running"),
      }),
    },
    async (args) => {
      if (args.ensureRunning) {
        const s = await ensureHeadlessService();
        return jsonResult({ ok: true, headlessService: s });
      }
      const current = readServiceJson();
      const isAlive = current?.pid ? isPidAlive(current.pid) : false;
      return jsonResult({
        ok: true,
        headlessService: {
          running: isAlive,
          url: current?.url,
          pid: current?.pid,
          version: current?.version,
        },
      });
    },
  );

  server.registerTool(
    "oc_get_session_rendered",
    {
      description: "Get a session's execution output rendered with OpenCode app components (thoughts, tool runs with terminal stdout/exit code, markdown prose, errors) instead of raw JSON.",
      inputSchema: z.object({
        sessionID: z.string().describe("Session ID"),
      }),
    },
    async (args) => {
      const client = await getOpenCodeClient();
      const [session, messages] = await Promise.all([
        client.session.get({ sessionID: args.sessionID }),
        client.message.list({ sessionID: args.sessionID, limit: 100, order: "asc" }),
      ]);
      const formatted = formatSessionMessages(session, (messages as any)?.data || messages || []);
      const tui = renderSessionTuiComponent(formatted);

      return {
        content: [
          { type: "text", text: tui },
        ],
      };
    },
  );

  // Auto-start CPU dashboard on server launch
  startDashboardServer().catch((err) => {
    console.error("[claude-opencode-mcp] Dashboard auto-start warning:", err);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("[claude-opencode-mcp] stdio server listening");
}

void runStdioServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[claude-opencode-mcp] fatal:", redactErrorMessage(err));
  process.exit(1);
});
