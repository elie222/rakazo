import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { RakazoDesktopProxyState } from "@rakazo/contracts";
import { isNonPublicAddress } from "@rakazo/contracts";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { app } from "electron";
import { handleIpc } from "../ipc/ipc.js";

const PREFS_FILE = "local-proxy.json";
const MAX_CONNECT_TIMEOUT_MS = 15_000;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const nominated = new Set<string>();
  const connectionHeader = headers.connection;
  const rawTokens = Array.isArray(connectionHeader)
    ? connectionHeader
    : typeof connectionHeader === "string"
      ? [connectionHeader]
      : [];
  for (const raw of rawTokens) {
    for (const token of raw.split(",")) {
      const clean = token.trim().toLowerCase();
      if (clean) nominated.add(clean);
    }
  }
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export type LocalProxyLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface LocalWebProxyController {
  state: () => RakazoDesktopProxyState;
  setEnabled: (enabled: boolean) => Promise<RakazoDesktopProxyState>;
  close: () => Promise<void>;
}

/** Rejects loopback, link-local, RFC1918, ULA, and unspecified addresses to prevent SSRF. */
export function isBlockedProxyAddress(address: string): boolean {
  const lower = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!lower || lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (net.isIP(lower)) return isNonPublicAddress(lower);
  return false;
}

type ResolveTargetResult = { kind: "ok"; ip: string } | { kind: "blocked" } | { kind: "failed" };

async function resolveSafeTarget(
  hostname: string,
  dnsLookup: LocalProxyLookup,
  signal: AbortSignal,
  dnsTimeoutMs: number,
): Promise<ResolveTargetResult> {
  const clean = hostname.trim().replace(/^\[|\]$/g, "");
  if (!clean || isBlockedProxyAddress(clean)) return { kind: "blocked" };
  if (net.isIP(clean)) return { kind: "ok", ip: clean };
  try {
    const records = await withAbort(
      dnsLookup(clean, { all: true }),
      deadlineSignal(dnsTimeoutMs, signal),
    );
    if (records.length === 0) return { kind: "failed" };
    if (records.some((record) => isNonPublicAddress(record.address))) return { kind: "blocked" };
    return { kind: "ok", ip: records[0]!.address };
  } catch {
    return { kind: "failed" };
  }
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? Number.parseInt(rest.slice(1), 10) : 443;
    return host && Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : null;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = trimmed.slice(0, colon);
  const port = Number.parseInt(trimmed.slice(colon + 1), 10);
  return host && Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : null;
}

async function readSavedEnabled(userDataDir: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(userDataDir, PREFS_FILE), "utf8");
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      void bestEffort("read desktop local web proxy state", Promise.reject(error));
    }
    return false;
  }
}

async function writeSavedEnabled(userDataDir: string, enabled: boolean): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(path.join(userDataDir, PREFS_FILE), JSON.stringify({ enabled }), "utf8");
}

/**
 * Opt-in loopback-only (`127.0.0.1`) HTTP/CONNECT forward proxy so bots can route public web
 * requests through this desktop computer's residential network. Always refuses private/local
 * destinations and cleanly closes sockets on stop.
 */
export async function createLocalWebProxy(options: {
  userDataDir: string;
  dnsLookup?: LocalProxyLookup;
  dnsTimeoutMs?: number;
  connectTimeoutMs?: number;
}): Promise<LocalWebProxyController> {
  const dnsLookup = options.dnsLookup ?? ((host, opts) => lookup(host, opts));
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? MAX_CONNECT_TIMEOUT_MS;
  let enabled = false;
  let closed = false;
  let url: string | null = null;
  let server: http.Server | null = null;
  let serverAbort: AbortController | null = null;
  const sockets = new Set<Duplex>();
  const activeRequests = new Set<http.ClientRequest>();
  let transitionQueue: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = transitionQueue.then(work, work);
    transitionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function trackSocket(socket: Duplex) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }

  async function stopServer(): Promise<void> {
    const active = server;
    const activeAbort = serverAbort;
    server = null;
    serverAbort = null;
    url = null;
    activeAbort?.abort();
    for (const req of activeRequests) req.destroy();
    activeRequests.clear();
    if (!active) return;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }

  async function startServer(): Promise<void> {
    if (server) return;
    const currentAbort = new AbortController();
    const nextServer = http.createServer((req, res) => {
      void (async () => {
        let parsed: URL;
        try {
          parsed = new URL(req.url ?? "");
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Bad proxy request");
          return;
        }
        if (parsed.protocol !== "http:") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("Only http requests or CONNECT tunnels are supported");
          return;
        }
        const resolved = await resolveSafeTarget(
          parsed.hostname,
          dnsLookup,
          currentAbort.signal,
          dnsTimeoutMs,
        );
        if (currentAbort.signal.aborted || res.destroyed || req.destroyed) {
          if (!res.destroyed) res.destroy();
          return;
        }
        if (resolved.kind === "blocked") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Destination address is not allowed");
          return;
        }
        if (resolved.kind === "failed") {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Could not resolve destination host");
          return;
        }
        const headers = stripHopByHopHeaders(req.headers);
        const upstream = http.request(
          {
            host: resolved.ip,
            port: parsed.port ? Number.parseInt(parsed.port, 10) : 80,
            method: req.method,
            path: `${parsed.pathname}${parsed.search}`,
            headers: { ...headers, host: parsed.host },
            timeout: connectTimeoutMs,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHopHeaders(upstreamRes.headers));
            upstreamRes.pipe(res);
          },
        );
        activeRequests.add(upstream);
        upstream.once("close", () => activeRequests.delete(upstream));
        upstream.on("timeout", () => {
          upstream.destroy(new Error("Upstream timed out"));
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
          if (!res.writableEnded) res.end("Upstream connection failed");
        });
        res.once("close", () => {
          if (!res.writableEnded) upstream.destroy();
        });
        req.pipe(upstream);
      })();
    });

    nextServer.on("connection", trackSocket);

    nextServer.on("connect", (req, clientSocket, head) => {
      trackSocket(clientSocket);
      let activeUpstream: net.Socket | null = null;
      clientSocket.on("error", () => activeUpstream?.destroy());
      void (async () => {
        const target = parseAuthority(req.url ?? "");
        if (!target) {
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        const resolved = await resolveSafeTarget(
          target.host,
          dnsLookup,
          currentAbort.signal,
          dnsTimeoutMs,
        );
        if (currentAbort.signal.aborted || clientSocket.destroyed) {
          if (!clientSocket.destroyed) clientSocket.destroy();
          return;
        }
        if (resolved.kind === "blocked") {
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        if (resolved.kind === "failed") {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          return;
        }
        const upstream = net.connect(target.port, resolved.ip, () => {
          if (currentAbort.signal.aborted || clientSocket.destroyed) {
            upstream.destroy();
            return;
          }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        activeUpstream = upstream;
        trackSocket(upstream);
        upstream.setTimeout(connectTimeoutMs, () => {
          upstream.destroy();
          if (!clientSocket.destroyed) clientSocket.destroy();
        });
        upstream.once("close", () => {
          if (!clientSocket.destroyed) clientSocket.destroy();
        });
        upstream.on("error", () => {
          if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        });
      })();
    });

    await new Promise<void>((resolve, reject) => {
      nextServer.once("error", reject);
      nextServer.listen(0, "127.0.0.1", () => {
        nextServer.off("error", reject);
        resolve();
      });
    });

    const address = nextServer.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => nextServer.close(() => resolve()));
      throw new Error("Could not bind loopback proxy port");
    }
    server = nextServer;
    serverAbort = currentAbort;
    url = `http://127.0.0.1:${address.port}`;
  }

  const saved = await readSavedEnabled(options.userDataDir);
  if (saved) {
    const started = await bestEffort(
      "start desktop local web proxy",
      startServer().then(() => true),
    );
    enabled = started === true;
    if (!enabled) url = null;
  }

  return {
    state: () => ({ enabled, url }),
    setEnabled(next: boolean): Promise<RakazoDesktopProxyState> {
      return serialize(async () => {
        if (closed) return { enabled: false, url: null };
        if (next) {
          await startServer();
          try {
            await writeSavedEnabled(options.userDataDir, true);
          } catch (error) {
            await stopServer();
            enabled = false;
            throw error;
          }
          enabled = true;
        } else {
          await writeSavedEnabled(options.userDataDir, false);
          await stopServer();
          enabled = false;
        }
        return { enabled, url };
      });
    },
    close(): Promise<void> {
      return serialize(async () => {
        closed = true;
        await stopServer();
        enabled = false;
      });
    },
  };
}

/** Starts the opt-in loopback web proxy, registers its IPC channels, and closes it on app quit. */
export async function startDesktopLocalProxy(
  userDataDir: string,
): Promise<LocalWebProxyController> {
  const controller = await createLocalWebProxy({ userDataDir });
  handleIpc("desktop.proxy.state", () => controller.state());
  handleIpc("desktop.proxy.setEnabled", async (_event, next) =>
    typeof next === "boolean" ? controller.setEnabled(next) : controller.state(),
  );
  app.on("before-quit", () => {
    void bestEffort("stop desktop local web proxy", controller.close());
  });
  return controller;
}
