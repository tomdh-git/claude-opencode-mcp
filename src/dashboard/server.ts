import path from "node:path";
import fs from "node:fs";
import { cpuMonitor } from "./monitor.js";
import { formatSessionMessages } from "./render.js";
import { getOpenCodeClient, interruptSession, promptSession } from "../openCode.js";
import { kiloRotate } from "../kilo.js";

const DEFAULT_PORT = 4040;
let runningServer: any = null;
let currentPort = DEFAULT_PORT;

export function getDashboardUrl(): string {
  return `http://localhost:${currentPort}`;
}

export function getUiHtml(): string {
  const uiHtmlPath = path.join(import.meta.dir, "ui.html");
  try {
    return fs.readFileSync(uiHtmlPath, "utf8");
  } catch {
    return "<h1>OpenCode CPU Dashboard</h1>";
  }
}

export async function startDashboardServer(preferredPort = DEFAULT_PORT): Promise<{ port: number; url: string; server: any }> {
  if (runningServer) {
    return { port: currentPort, url: getDashboardUrl(), server: runningServer };
  }

  // Initialize and start CPU monitor
  await cpuMonitor.start().catch((e) => console.error("[Dashboard] Monitor start error:", e));

  const uiHtmlPath = path.join(import.meta.dir, "ui.html");
  let uiHtml = "";
  try {
    uiHtml = fs.readFileSync(uiHtmlPath, "utf8");
  } catch {
    uiHtml = "<h1>OpenCode CPU Dashboard (ui.html not found)</h1>";
  }

  let chosenPort = preferredPort;
  let server: any = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      chosenPort = preferredPort + attempt;
      server = Bun.serve({
        port: chosenPort,
        async fetch(req) {
          const url = new URL(req.url);
          const pathname = url.pathname;

          // CORS headers for local GUI clients
          const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          };

          if (req.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
          }

          // UI HTML
          if (pathname === "/" || pathname === "/index.html") {
            return new Response(uiHtml, {
              headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
            });
          }

          // GET /api/status - CPU Status & Pipeline Metrics
          if (pathname === "/api/status") {
            const report = await cpuMonitor.getReport();
            return new Response(JSON.stringify(report), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // GET /api/cores - Execution units
          if (pathname === "/api/cores") {
            const report = await cpuMonitor.getReport();
            return new Response(JSON.stringify(report.cores), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // GET /api/session/:id - Rendered OpenCode message stream (Not raw JSON)
          const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)$/);
          if (sessionMatch && sessionMatch[1] && req.method === "GET") {
            const sessionId = sessionMatch[1];
            try {
              const client = await getOpenCodeClient();
              const [sess, msgs] = await Promise.all([
                client.session.get({ sessionID: sessionId }),
                client.message.list({ sessionID: sessionId, limit: 100, order: "asc" }),
              ]);
              const formatted = formatSessionMessages(sess, (msgs as any)?.data || msgs || []);
              return new Response(JSON.stringify(formatted), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (err: any) {
              return new Response(JSON.stringify({ error: String(err?.message || err) }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // GET /api/session/:id/raw - Raw JSON session data
          const rawMatch = pathname.match(/^\/api\/session\/([^/]+)\/raw$/);
          if (rawMatch && rawMatch[1] && req.method === "GET") {
            const sessionId = rawMatch[1];
            try {
              const client = await getOpenCodeClient();
              const [sess, msgs] = await Promise.all([
                client.session.get({ sessionID: sessionId }),
                client.message.list({ sessionID: sessionId, limit: 100, order: "asc" }),
              ]);
              return new Response(JSON.stringify({ session: sess, messages: (msgs as any)?.data || msgs || [] }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (err: any) {
              return new Response(JSON.stringify({ error: String(err?.message || err) }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // POST /api/session/:id/interrupt
          const interruptMatch = pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
          if (interruptMatch && interruptMatch[1] && req.method === "POST") {
            const sessionId = interruptMatch[1];
            try {
              const res = await interruptSession(sessionId);
              return new Response(JSON.stringify({ ok: true, result: res }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (err: any) {
              return new Response(JSON.stringify({ error: String(err?.message || err) }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // POST /api/session/:id/prompt
          const promptMatch = pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
          if (promptMatch && promptMatch[1] && req.method === "POST") {
            const sessionId = promptMatch[1];
            try {
              const body = (await req.json().catch(() => ({}))) as any;
              const text = body?.text || "continue";
              const res = await promptSession(sessionId, text);
              return new Response(JSON.stringify({ ok: true, result: res }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (err: any) {
              return new Response(JSON.stringify({ error: String(err?.message || err) }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // POST /api/kilo/rotate
          if (pathname === "/api/kilo/rotate" && req.method === "POST") {
            try {
              const res = await kiloRotate();
              return new Response(JSON.stringify({ ok: true, ...res }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (err: any) {
              return new Response(JSON.stringify({ error: String(err?.message || err) }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // GET /api/events - Server-Sent Events (SSE) Live Feed
          if (pathname === "/api/events") {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                // Send initial connection event
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: "stream.connected", timestamp: Date.now(), summary: "Connected to live OpenCode event bus" })}\n\n`)
                );

                // Send recent events
                for (const ev of cpuMonitor.getGlobalEvents().slice(0, 15).reverse()) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
                }

                // Listener for new events
                const listener = (ev: any) => {
                  try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
                  } catch {
                    cpuMonitor.off("event", listener);
                  }
                };

                cpuMonitor.on("event", listener);

                req.signal.addEventListener("abort", () => {
                  cpuMonitor.off("event", listener);
                });
              },
            });

            return new Response(stream, {
              headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          return new Response("Not Found", { status: 404, headers: corsHeaders });
        },
      });

      break;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" || String(err).includes("address already in use")) {
        continue;
      }
      throw err;
    }
  }

  if (!server) {
    throw new Error(`Failed to bind dashboard server after trying ports ${preferredPort}-${preferredPort + 9}`);
  }

  runningServer = server;
  currentPort = chosenPort;

  // Persist port file for CLI discovery
  try {
    fs.writeFileSync(path.join(process.cwd(), ".dashboard-port"), String(chosenPort), "utf8");
  } catch {}

  console.error(`[claude-opencode-mcp] CPU Dashboard live at http://localhost:${chosenPort}`);

  return {
    port: chosenPort,
    url: `http://localhost:${chosenPort}`,
    server,
  };
}

// Standalone execution support
if (import.meta.main) {
  startDashboardServer().then(({ url }) => {
    console.log(`OpenCode CPU Dashboard running at ${url}`);
  });
}
