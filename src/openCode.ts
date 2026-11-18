import { OpenCode } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { redactErrorMessage, redactHeaders, isDirectoryAllowed, parseModelRef } from "./config.js";
import { ensureHeadlessService, findOpenCodeCli } from "./headless.js";

type OpenCodeClient = ReturnType<typeof OpenCode.make>;

/** Error thrown when the OpenCode service cannot be reached or used. */
export class OpenCodeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeConnectionError";
  }
}

let clientCache: { client: OpenCodeClient; endpoint: Endpoint } | null = null;

/** Headers for the service endpoint (basic auth from the service registration file). */
type EndpointAuthHeaders = ReturnType<typeof Service.headers>;

/**
 * Lazily create (and cache) an authenticated OpenCode client.
 *
 * Discovers the local OpenCode service via `Service.ensure()`, derives the
 * authorization header from `Service.headers(endpoint)`, and constructs the
 * `@opencode/client` instance. Falls back to a best-effort shell invocation
 * only when the client package itself cannot be used (not for per-call
 * fallback — the service must be reachable for the bridge to function).
 */
export async function getOpenCodeClient(): Promise<OpenCodeClient> {
  if (clientCache) return clientCache.client;

  // Proactively ensure OpenCode service is running headlessly
  await ensureHeadlessService().catch((err) => {
    console.error("[openCode] ensureHeadlessService notice:", redactErrorMessage(err));
  });

  const cliPath = findOpenCodeCli();
  let endpoint: Endpoint;
  try {
    endpoint = await Service.ensure({
      command: [cliPath, "serve", "--service"],
    } as any);
  } catch (err) {
    const detail = redactErrorMessage(err);
    throw new OpenCodeConnectionError(
      `Unable to connect to the local OpenCode service. Ensure OpenCode is installed and reachable. Underlying: ${detail}`,
    );
  }

  const authHeaders: EndpointAuthHeaders | undefined = Service.headers(endpoint);
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: authHeaders ? { ...authHeaders } : undefined,
  } as Parameters<typeof OpenCode.make>[0]);

  clientCache = { client, endpoint };
  return client;
}

export { type Endpoint };

/** Clear the cached client (useful for tests or after re-configuring auth). */
export function resetOpenCodeClient(): void {
  clientCache = null;
}

/** Best-effort shell fallback for read-only OpenCode API calls when the client
 *  package is unavailable. Returns the parsed JSON or undefined on failure. */
export async function opencodeApiShell<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T | undefined> {
  try {
    const { spawnSync } = await import("node:child_process");
    const args = ["api", method, apiPath];
    let input: string | undefined;
    if (body != null && method !== "GET" && method !== "DELETE") {
      input = JSON.stringify(body);
    }
    const result = spawnSync("opencode", args, {
      encoding: "utf8",
      input,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Session management                                                 */
/* ------------------------------------------------------------------ */

export interface ListSessionsInput {
  limit?: number;
  order?: "asc" | "desc";
  search?: string;
  parentID?: string | null;
  archived?: boolean;
  directory?: string;
  project?: string;
  subpath?: string;
  cursor?: string;
}

export interface SessionCreateInput {
  directory: string;
  title?: string;
  agent?: string;
  model?: string;
  parentID?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionResult {
  session: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>;
  messages?: unknown[];
}

export async function listSessions(input: ListSessionsInput = {}): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.session.list({
    limit: input.limit,
    order: input.order,
    search: input.search,
    parentID: input.parentID,
    archived: input.archived,
    directory: input.directory,
    project: input.project,
    subpath: input.subpath,
    cursor: input.cursor,
  });
}

export async function createSession(input: SessionCreateInput): Promise<unknown> {
  if (!isDirectoryAllowed(input.directory)) {
    throw new Error(`Directory not allowed by workspace allowlist: ${input.directory}`);
  }
  const client = await getOpenCodeClient();
  const model = input.model ? parseModelRef(input.model) : undefined;
  return client.session.create({
    title: input.title ?? null,
    agent: input.agent ?? null,
    model: model ? { id: model.id, providerID: model.providerID, variant: model.variant } : null,
    location: { directory: input.directory },
    parentID: input.parentID ?? null,
    metadata: (input.metadata ?? null) as any,
  });
}

export async function getSession(sessionID: string): Promise<SessionResult> {
  const client = await getOpenCodeClient();
  const [session, messages] = await Promise.all([
    client.session.get({ sessionID }),
    client.message.list({ sessionID, limit: 50, order: "desc" }),
  ]);
  return {
    session,
    messages: (messages as unknown as unknown[]) ?? [],
  };
}

export async function switchModel(sessionID: string, model: string): Promise<void> {
  const client = await getOpenCodeClient();
  const ref = parseModelRef(model);
  return client.session.switchModel({ sessionID, model: { id: ref.id, providerID: ref.providerID, variant: ref.variant } });
}

export async function switchAgent(sessionID: string, agent: string): Promise<void> {
  const client = await getOpenCodeClient();
  return client.session.switchAgent({ sessionID, agent });
}

export async function interruptSession(sessionID: string): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.session.interrupt({ sessionID });
}

export async function deleteSession(sessionID: string): Promise<void> {
  const client = await getOpenCodeClient();
  return client.session.remove({ sessionID });
}

export async function promptSession(sessionID: string, text: string): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.session.prompt({ sessionID, text });
}

/* ------------------------------------------------------------------ */
/* Agent / model / provider                                           */
/* ------------------------------------------------------------------ */

export interface ListAgentsInput {
  directory?: string;
}

export async function listAgents(input: ListAgentsInput = {}): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.agent.list({
    location: input.directory ? { directory: input.directory } : undefined,
  });
}

export async function listModels(directory?: string): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.model.list({
    location: directory ? { directory } : undefined,
  });
}

export async function listProviders(directory?: string): Promise<unknown> {
  const client = await getOpenCodeClient();
  return client.provider.list({
    location: directory ? { directory } : undefined,
  });
}

/** Sanitize an OpenCode error for safe return to the MCP client. */
export function sanitizeOpenCodeError(err: unknown): Error {
  if (err instanceof OpenCodeConnectionError) return err;
  const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
  return new Error(`OpenCode API error: ${message || "unknown error"}`);
}
