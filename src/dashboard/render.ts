import { maskDirectory, redactErrorMessage } from "../config.js";

/**
 * Formats OpenCode messages and session structures into rich, application-grade
 * rendered components (similar to OpenCode app) instead of raw JSON.
 */

export interface FormattedToolCall {
  id: string;
  name: string;
  commandOrInput: string;
  stdout: string;
  exitCode?: number;
  status: "completed" | "running" | "error";
  durationMs?: number;
}

export interface FormattedMessage {
  id: string;
  type: "user" | "assistant" | "system" | "idle";
  agent?: string;
  model?: string;
  createdTime: number;
  completedTime?: number;
  durationMs?: number;
  thought?: string;
  thoughtDurationMs?: number;
  tools: FormattedToolCall[];
  text: string;
  error?: {
    type?: string;
    message: string;
    status?: number;
    rawBody?: string;
  };
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead?: number;
  };
}

export interface FormattedSessionDetail {
  id: string;
  title: string;
  directory: string;
  agent?: string;
  model?: string;
  outcome?: string;
  createdTime: number;
  updatedTime: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
  };
  messages: FormattedMessage[];
}

export function formatSessionMessages(session: any, rawMessages: any[]): FormattedSessionDetail {
  const messages: FormattedMessage[] = [];

  const list = Array.isArray(rawMessages) ? rawMessages : [];
  // Sort messages chronologically by creation time
  const sorted = [...list].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

  for (const m of sorted) {
    const formatted: FormattedMessage = {
      id: m.id || "msg_" + Math.random().toString(36).slice(2),
      type: m.type ?? "assistant",
      agent: m.agent,
      model: m.model ? `${m.model.providerID ?? ""}/${m.model.id ?? ""}` : undefined,
      createdTime: m.time?.created ?? 0,
      completedTime: m.time?.completed,
      durationMs: m.time?.completed && m.time?.created ? m.time.completed - m.time.created : undefined,
      tools: [],
      text: "",
      tokens: m.tokens
        ? {
            input: m.tokens.input ?? 0,
            output: m.tokens.output ?? 0,
            reasoning: m.tokens.reasoning ?? 0,
            cacheRead: m.tokens.cache?.read ?? 0,
          }
        : undefined,
    };

    if (m.error) {
      formatted.error = {
        type: m.error.type,
        message: redactErrorMessage(m.error.message || "Unknown error"),
        status: m.error.status,
        rawBody: m.error.response?.body,
      };
    }

    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;

        if (part.type === "reasoning") {
          formatted.thought = (formatted.thought ? formatted.thought + "\n\n" : "") + (part.text ?? "");
          if (part.time?.created && part.time?.completed) {
            formatted.thoughtDurationMs = (formatted.thoughtDurationMs ?? 0) + (part.time.completed - part.time.created);
          }
        } else if (part.type === "tool") {
          const state = part.state || {};
          let stdout = "";
          if (Array.isArray(state.content)) {
            stdout = state.content.map((c: any) => c.text ?? "").join("\n");
          }

          let commandOrInput = "";
          if (state.input) {
            if (typeof state.input === "string") {
              commandOrInput = state.input;
            } else if (state.input.command) {
              commandOrInput = String(state.input.command);
            } else if (state.input.filePath || state.input.path) {
              commandOrInput = `${state.input.filePath || state.input.path}`;
            } else {
              commandOrInput = JSON.stringify(state.input, null, 2);
            }
          }

          const toolDuration =
            part.time?.completed && part.time?.created ? part.time.completed - part.time.created : undefined;

          formatted.tools.push({
            id: part.id || "tool_" + Math.random().toString(36).slice(2),
            name: part.name || "tool",
            commandOrInput,
            stdout,
            exitCode: state.metadata?.exit,
            status: state.status ?? "completed",
            durationMs: toolDuration,
          });
        } else if (part.type === "text") {
          formatted.text += (formatted.text ? "\n" : "") + (part.text ?? "");
        }
      }
    } else if (typeof m.text === "string") {
      formatted.text = m.text;
    }

    messages.push(formatted);
  }

  const modelStr = session.model
    ? `${session.model.providerID ?? ""}/${session.model.id ?? ""}`
    : undefined;

  return {
    id: session.id,
    title: session.title || "Untitled Session",
    directory: maskDirectory(session.location?.directory || ""),
    agent: session.agent,
    model: modelStr,
    outcome: session.outcome,
    createdTime: session.time?.created ?? 0,
    updatedTime: session.time?.updated ?? 0,
    tokens: {
      input: session.tokens?.input ?? 0,
      output: session.tokens?.output ?? 0,
      reasoning: session.tokens?.reasoning ?? 0,
      cacheRead: session.tokens?.cache?.read ?? 0,
    },
    messages,
  };
}
