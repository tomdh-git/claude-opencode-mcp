import type { CpuStatusReport, CpuCore } from "./monitor.js";
import type { FormattedSessionDetail } from "./render.js";
import { maskDirectory } from "../config.js";

/** Formats a compact duration string */
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Formats token numbers with k/M suffix */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/**
 * Renders an inline custom CPU Architecture & Pipeline Telemetry Component
 * directly in Claude Code's terminal window.
 */
export function renderCpuTuiComponent(report: CpuStatusReport): string {
  const line = "═".repeat(84);
  const thin = "─".repeat(84);

  const statusLabel = report.service.running
    ? `HEADLESS DAEMON (PID: ${report.service.pid ?? "?"} · v${report.service.version ?? "2.3"})`
    : `STOPPED`;

  const activeKey = report.kiloPool.activeAccountId || "default";

  let out = `
╔${line}╗
║  ⚡ OPENCODE CPU CO-PROCESSOR TELEMETRY                                            ║
║  Status: ${statusLabel.padEnd(46)} Key: ${activeKey.padEnd(21)}║
╠${line}╣
║  CORES:  [${report.metrics.activeCores}/${report.metrics.totalCores} Active]  │  IPC: ${report.metrics.ipcTokensPerSec.toFixed(1).padStart(4)} tok/s  │  WORKLOAD: ${fmtTokens(report.metrics.totalTokens.output)} out (${report.metrics.cacheHitRatio}% Cache Hit)║
║  STALLS: [${report.metrics.stalledCores} Hazards] │  UPTIME: ${formatDuration(report.uptimeSeconds).padEnd(9)}│  TOTAL TOKENS: ${fmtTokens(report.metrics.totalTokens.input + report.metrics.totalTokens.output + report.metrics.totalTokens.reasoning).padEnd(19)}║
╠${line}╣`;

  if (report.recentHazards.length > 0) {
    out += `\n║  ⚠️  ACTIVE PIPELINE HAZARDS DETECTED:${" ".repeat(46)}║`;
    for (const h of report.recentHazards.slice(0, 3)) {
      const hzStr = `[${h.type}] ${h.reason} (${h.elapsedSec}s ago)`;
      out += `\n║    • ${hzStr.slice(0, 78).padEnd(80)}║`;
      const rec = `Action: ${h.recommendedAction}`;
      out += `\n║      ↳ ${rec.slice(0, 76).padEnd(78)}║`;
    }
    out += `\n╠${line}╣`;
  }

  // Render Cores
  out += `\n║  EXECUTION UNITS (CORES):${" ".repeat(59)}║`;

  const displayCores = report.cores.slice(0, 8);
  if (displayCores.length === 0) {
    out += `\n║    (No session cores allocated yet)${" ".repeat(49)}║`;
  } else {
    for (const core of displayCores) {
      const stageBadge = `[${core.stage}]`;
      const title = core.title.length > 48 ? core.title.slice(0, 45) + "..." : core.title;
      out += `\n║                                                                                    ║`;
      out += `\n║  CORE #${core.coreId}  ${stageBadge.padEnd(14)} ${title.padEnd(58)}║`;
      out += `\n║    ├─ Agent: ${core.agent.padEnd(10)} │ Model: ${core.model.padEnd(20)} │ ID: ${core.sessionId.slice(-12).padEnd(17)}║`;

      if (core.currentTool) {
        const toolStr = `[TOOL] ${core.currentTool.name}: ${core.currentTool.inputPreview.slice(0, 42)} (${Math.round(core.currentTool.elapsedMs / 1000)}s)`;
        out += `\n║    ├─ Pipeline: ${toolStr.padEnd(67)}║`;
      } else if (core.stage === "EXECUTING") {
        out += `\n║    ├─ Pipeline: [INFERENCE] Streaming tokens via LLM runtime...${" ".repeat(15)}║`;
      } else if (core.stage === "STALLED" && core.stallHazard) {
        const stStr = `[HAZARD] ${core.stallHazard.type}: ${core.stallHazard.reason.slice(0, 42)}`;
        out += `\n║    ├─ Pipeline: ${stStr.padEnd(67)}║`;
      } else {
        out += `\n║    ├─ Pipeline: [${core.stage}] Outcome: ${String(core.outcome || "none").padEnd(46)}║`;
      }

      const tokStr = `In ${fmtTokens(core.tokens.input)} │ Out ${fmtTokens(core.tokens.output)} │ Reason ${fmtTokens(core.tokens.reasoning)} │ Cache ${fmtTokens(core.tokens.cacheRead)}`;
      out += `\n║    └─ Tokens: ${tokStr.padEnd(70)}║`;
    }
  }

  if (report.cores.length > 8) {
    const more = `... and ${report.cores.length - 8} more background cores`;
    out += `\n║                                                                                    ║`;
    out += `\n║    ${more.padEnd(80)}║`;
  }

  out += `\n╚${line}╝\n`;
  return out;
}

/**
 * Renders an inline OpenCode Conversational Component showing actual rendered output
 * (thinking blocks, tool execution with stdout and exit codes, markdown prose)
 * instead of raw JSON.
 */
export function renderSessionTuiComponent(session: FormattedSessionDetail): string {
  const line = "─".repeat(84);
  const doubleLine = "═".repeat(84);

  let out = `
╔${doubleLine}╗
║  OPENCODE NODE INSPECTOR: ${session.title.slice(0, 56).padEnd(56)}║
║  ID: ${session.id.padEnd(30)} Agent: ${(session.agent ?? "default").padEnd(16)} Model: ${(session.model ?? "default").padEnd(16)}║
║  Directory: ${maskDirectory(session.directory).slice(0, 71).padEnd(71)}║
╚${doubleLine}╝
`;

  if (!session.messages || session.messages.length === 0) {
    out += `\n  (No recorded messages in this session)\n`;
    return out;
  }

  for (const msg of session.messages) {
    const isUser = msg.type === "user";
    const timeStr = msg.createdTime ? new Date(msg.createdTime).toLocaleTimeString() : "";

    if (isUser) {
      out += `\n┌─ [USER PROMPT] ${line.slice(0, 60)} ${timeStr} ─┐\n`;
      const cleanText = msg.text.replace(/\r?\n/g, "\n  ");
      out += `  ${cleanText}\n`;
      out += `└${line}┘\n`;
      continue;
    }

    out += `\n┌─ [ASSISTANT: ${msg.agent ?? "agent"}] ${line.slice(0, 52)} ${timeStr} ─┐\n`;

    // Render Thought Process
    if (msg.thought) {
      const dur = msg.thoughtDurationMs ? ` (${(msg.thoughtDurationMs / 1000).toFixed(1)}s)` : "";
      out += `  ┌─ 💭 THOUGHT PROCESS${dur} ${"─".repeat(50)}┐\n`;
      const thoughtLines = msg.thought.trim().split("\n");
      for (const tl of thoughtLines) {
        out += `  │  ${tl.slice(0, 78)}\n`;
      }
      out += `  └${"─".repeat(78)}┘\n`;
    }

    // Render Tool Calls
    if (msg.tools && msg.tools.length > 0) {
      for (const t of msg.tools) {
        const exitStr = t.exitCode !== undefined ? `exit: ${t.exitCode}` : t.status;
        out += `  ┌─ 🔧 TOOL: ${t.name} (${exitStr}) ${"─".repeat(50)}┐\n`;
        if (t.commandOrInput) {
          out += `  │  $ ${t.commandOrInput.slice(0, 74)}\n`;
        }
        if (t.stdout) {
          out += `  │  ${"─".repeat(76)}\n`;
          const stdoutLines = t.stdout.trim().split("\n").slice(0, 15);
          for (const sol of stdoutLines) {
            out += `  │  ${sol.slice(0, 76)}\n`;
          }
          if (t.stdout.trim().split("\n").length > 15) {
            out += `  │  ... (${t.stdout.trim().split("\n").length - 15} more lines truncated)\n`;
          }
        }
        out += `  └${"─".repeat(78)}┘\n`;
      }
    }

    // Render Assistant Text
    if (msg.text) {
      out += `\n  ${msg.text.replace(/\r?\n/g, "\n  ")}\n`;
    }

    // Render Errors
    if (msg.error) {
      out += `  ┌─ ⚠️ ERROR [${msg.error.status || msg.error.type || "Fault"}] ${"─".repeat(50)}┐\n`;
      out += `  │  ${msg.error.message.slice(0, 76)}\n`;
      out += `  └${"─".repeat(78)}┘\n`;
    }

    out += `└${line}┘\n`;
  }

  return out;
}
