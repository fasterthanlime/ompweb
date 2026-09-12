/**
 * ompweb custom Next.js HTTP server.
 *
 * Next 16 has no public custom-server API; the supported pathway is
 * `next/dist/server/lib/start-server`'s `getRequestHandlers`, the same
 * function the `next dev` / `next start` CLIs use internally. It is given the
 * server we already own, and returns the exact `requestHandler` /
 * `upgradeHandler` pair the CLIs wire up themselves. We keep ownership of the
 * HTTP server and its `upgrade` events so the dictation endpoint
 * (`/api/dictation/live/socket`) can be a same-origin WebSocket; every other
 * request and upgrade (dev HMR included) is delegated to Next.
 *
 * Startup:
 *   dev:   node --experimental-strip-types server/omp-web-server.ts --dev -H 127.0.0.1 -p 30178
 *   prod:  node --experimental-strip-types server/omp-web-server.ts -H 127.0.0.1 -p 30177
 * The packaged launcher (`bin/omp-web.js`) spawns this with
 * `OMP_WEB_PACKAGE_DIR` / `OMP_WEB_PORT` / `OMP_WEB_HOSTNAME` set; CLI flags
 * win over env, env wins over defaults (matching the `next` CLIs).
 *
 * Security: password-session validation is delegated to lib/web-auth.ts (the
 * same helper the middleware uses), and upgrades must be same-origin: the
 * `Origin` header must match the `Host` header this server is being reached
 * at. Behind a TLS-terminating reverse proxy (`--auth-proxy`), the browser's
 * Origin scheme is https while this server speaks plain ws/http, so only
 * hostname (and explicit ports) are compared, never schemes — the proxy must
 * preserve the `Host` header. The proxy remains the outer auth boundary;
 * without a password configured the session-cookie check is skipped exactly
 * as in the request middleware.
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { getRequestHandlers } from "next/dist/server/lib/start-server.js";
import {
  attachLiveDictationSocket,
  closeAllLiveConnections,
  getActiveLiveConnectionCount,
  getRealtimeDictationConfig,
  MAX_CHUNK_BYTES,
  MAX_LIVE_CONNECTIONS,
} from "../lib/dictation-live.ts";
import {
  isWebPasswordEnabled,
  isValidWebSession,
  OMP_WEB_SESSION_COOKIE,
} from "../lib/web-auth.ts";

const require = createRequire(import.meta.url);
const pkgVersion: string = require("../package.json").version ?? "0.0.0";

const PROJECT_DIR = realpathSync(process.env.OMP_WEB_PACKAGE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
process.chdir(PROJECT_DIR);
const LIVE_SOCKET_PATH = "/api/dictation/live/socket";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface LaunchArgs {
  dev: boolean;
  port: number;
  hostname: string;
}

function parseArgs(argv = process.argv.slice(2), env = process.env): LaunchArgs {
  let port = env.PORT ?? "30177";
  let hostname = env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  const dev = argv.includes("--dev");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--port") {
      port = argv[i + 1] ?? port;
      i += 1;
    } else if (arg === "-H" || arg === "--hostname") {
      hostname = argv[i + 1] ?? hostname;
      i += 1;
    }
  }
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }
  return { dev, port: parsedPort, hostname };
}

const args = parseArgs();
const { dev, port, hostname } = args;

// Match the `next dev` CLI environment contract (next-dev.js forks its server
// with these private vars): route modules and dev render paths derive
// `isDev` from __NEXT_DEV_SERVER, and the bundler default is turbopack when
// nothing was configured.
if (dev) {
  process.env.__NEXT_DEV_SERVER = "1";
  process.env.TURBOPACK ??= "auto";
}

// ---------------------------------------------------------------------------
// Next handlers (initialized after the port is bound, like the CLIs)
// ---------------------------------------------------------------------------

let handlersReady: () => void = () => {};
let handlersFailed: (error: unknown) => void = () => {};
const handlersPromise = new Promise<void>((resolve, reject) => {
  handlersReady = resolve;
  handlersFailed = reject;
});
void handlersPromise.catch((error: unknown) => {
  console.error("Failed to initialize Next server:", error);
  process.exit(1);
});

let requestHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void) | null = null;
let upgradeHandler: ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> | void) | null = null;
let closeUpgraded: (() => void) | null = null;
let nextServer: { close(): Promise<void> } | null = null;

// ---------------------------------------------------------------------------
// Dictation WebSocket endpoint
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CHUNK_BYTES });
wss.on("error", (error) => {
  console.error("[dictation-live] websocket server error:", error);
});
wss.on("connection", (client) => {
  attachLiveDictationSocket(client);
});

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  409: "Conflict",
  503: "Service Unavailable",
};

/** Refuse an upgrade before the WebSocket handshake with a JSON HTTP error. */
function rejectUpgrade(socket: Duplex, statusCode: number, body: { error: string }): void {
  const payload = JSON.stringify(body);
  const head = [
    `HTTP/1.1 ${statusCode} ${STATUS_TEXT[statusCode] ?? "Error"}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  try {
    socket.end(head + payload);
  } catch {
    socket.destroy();
  }
}

/** Normalize an authority ("host", "host:port", "[::1]:port") or an Origin URL
 * to { hostname, port } with brackets stripped and case folded. */
function normalizeAuthority(value: string): { hostname: string; port: string } | null {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { hostname: url.hostname.toLowerCase(), port: url.port };
}

/**
 * Same-origin check for the dictation upgrade: the browser must be connecting
 * to the exact host it was served from (CSWSH defense). Browsers always send
 * `Origin` on WebSocket handshakes; non-browser clients cannot hold a valid
 * session cookie anyway, so a missing/forged Origin is rejected.
 *
 * Scheme is deliberately not compared: behind a TLS-terminating proxy the
 * page's Origin is https while this server is plain ws/http. Explicit ports
 * must match when both sides carry them; a missing port means the scheme
 * default and is tolerated (including https-via-proxy).
 */
function isSameOriginUpgrade(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || !origin || typeof host !== "string" || !host) return false;
  const originAuthority = normalizeAuthority(origin);
  const hostAuthority = normalizeAuthority(host);
  if (!originAuthority || !hostAuthority) return false;
  if (originAuthority.hostname !== hostAuthority.hostname) return false;
  if (originAuthority.port !== hostAuthority.port) return false;
  return true;
}

/** Extract the ompweb session cookie value, if present. */
function sessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === OMP_WEB_SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function handleLiveSocketUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const config = getRealtimeDictationConfig();
  const displayMode = new URL(req.url ?? "/", "http://localhost").searchParams.get("displayMode") ?? "immediate";
  if (displayMode !== "immediate" && displayMode !== "stable_words") { rejectUpgrade(socket, 400, { error: "Invalid dictation display mode" }); return; }
  if (!config.supportedDisplayModes.includes(displayMode)) { rejectUpgrade(socket, 409, { error: "Dictation display mode unavailable" }); return; }
  if (!config.enabled) {
    rejectUpgrade(socket, config.misconfigured ? 503 : 409, {
      error: config.misconfigured ? "Live dictation is misconfigured" : "Live dictation is not configured",
    });
    return;
  }
  if (!isSameOriginUpgrade(req)) {
    rejectUpgrade(socket, 403, { error: "Cross-origin WebSocket connections are not allowed" });
    return;
  }
  if (isWebPasswordEnabled() && !isValidWebSession(sessionCookie(req.headers.cookie))) {
    rejectUpgrade(socket, 401, { error: "Password required" });
    return;
  }
  if (getActiveLiveConnectionCount() >= MAX_LIVE_CONNECTIONS) {
    rejectUpgrade(socket, 503, { error: "Too many live dictation connections" });
    return;
  }
  try {
    wss.handleUpgrade(req, socket, head, (client) => {
      attachLiveDictationSocket(client, displayMode);
    });
  } catch {
    socket.destroy();
  }
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

// ---------------------------------------------------------------------------
// HTTP server + upgrade routing
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      await handlersPromise;
      if (!requestHandler) throw new Error("Next request handler unavailable");
      await requestHandler(req, res);
    } catch (error) {
      console.error(`Failed to handle request for ${req.url}`, error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      } else {
        res.destroy();
      }
    }
  })();
});

server.on("upgrade", (req, socket, head) => {
  // A failed upgrade must never crash the server.
  req.on("error", () => {});
  socket.on("error", () => {});

  if (pathnameOf(req.url) === LIVE_SOCKET_PATH) {
    handleLiveSocketUpgrade(req, socket, head);
    return;
  }
  void (async () => {
    try {
      await handlersPromise;
      if (!upgradeHandler) throw new Error("Next upgrade handler unavailable");
      await upgradeHandler(req, socket, head);
    } catch (error) {
      console.error(`Failed to handle upgrade for ${req.url}`, error);
      socket.destroy();
    }
  })();
});

function formattedBindHostname(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

server.on("listening", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.env.PORT = String(actualPort);
  process.env.__NEXT_PRIVATE_ORIGIN = `http://${formattedBindHostname(hostname)}:${actualPort}`;
  void initialize(actualPort);
});

async function initialize(actualPort: number): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await getRequestHandlers({
      dir: PROJECT_DIR,
      port: actualPort,
      isDev: dev,
      hostname,
      server,
      onDevServerCleanup: undefined,
    });
    requestHandler = result.requestHandler;
    upgradeHandler = result.upgradeHandler;
    closeUpgraded = result.closeUpgraded;
    nextServer = result.server;
  } catch (error) {
    handlersFailed(error);
    return;
  }

  const dictation = getRealtimeDictationConfig();
  console.log(`▲ Next.js custom server (ompweb v${pkgVersion}, ${dev ? "dev" : "start"})`);
  console.log(`- Local:        http://${formattedBindHostname(hostname)}:${actualPort}`);
  console.log(
    `- Live dictation: ${LIVE_SOCKET_PATH} (${dictation.enabled ? "enabled" : dictation.misconfigured ? "misconfigured" : "disabled"})`,
  );
  console.log(`✓ Ready in ${Date.now() - startedAt}ms`);
  handlersReady();
}

function shutdown(signal: NodeJS.Signals): void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  };
  closeAllLiveConnections();
  try {
    closeUpgraded?.();
  } catch {
    // HMR teardown is best-effort.
  }
  wss.close();
  void nextServer?.close().then(finish).catch(finish);
  server.close(finish);
  setTimeout(finish, 2500).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.on("error", (error: Error) => {
  console.error(`Failed to start server on ${hostname}:${port}:`, (error as NodeJS.ErrnoException).message ?? error);
  process.exit(1);
});

server.listen(port, hostname);