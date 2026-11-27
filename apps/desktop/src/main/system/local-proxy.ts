import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { RakazoDesktopProxyState } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import { app } from "electron";
import { handleIpc } from "../ipc/ipc.js";

const PREFS_FILE = "local-proxy.json";
const MAX_CONNECT_TIMEOUT_MS = 15_000;

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
  if (lower.startsWith("::ffff:")) {
    return isBlockedProxyAddress(lower.slice("::ffff:".length));
  }
  const ipVersion = net.isIP(lower);
  if (ipVersion === 4) {
    const parts = lower.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }
    return false;
  }
  return false;
}

async function resolveSafeTarget(
  hostname: string,
  dnsLookup: LocalProxyLookup,
): Promise<string | null> {
  const clean = hostname.trim().replace(/^\[|\]$/g, "");
  if (!clean || isBlockedProxyAddress(clean)) return null;
  if (net.isIP(clean)) return clean;
  try {
    const records = await dnsLookup(clean, { all: true });
    if (records.length === 0) return null;
    if (records.some((record) => isBlockedProxyAddress(record.address))) return null;
    return records[0]!.address;
  } catch {
    return null;
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
  } catch {
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
}): Promise<LocalWebProxyController> {
  const dnsLookup = options.dnsLookup ?? ((host, opts) => lookup(host, opts));
  let enabled = false;
  let url: string | null = null;
  let server: http.Server | null = null;
  const sockets = new Set<Duplex>();

  function trackSocket(socket: Duplex) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }

  async function stopServer(): Promise<void> {
    const active = server;
    server = null;
    url = null;
    if (!active) return;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }

  async function startServer(): Promise<void> {
    if (server) return;
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
        const safeIp = await resolveSafeTarget(parsed.hostname, dnsLookup);
        if (!safeIp) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Destination address is not allowed");
          return;
        }
        const headers = { ...req.headers };
        delete headers["proxy-connection"];
        delete headers["proxy-authorization"];
        const upstream = http.request(
          {
            host: safeIp,
            port: parsed.port ? Number.parseInt(parsed.port, 10) : 80,
            method: req.method,
            path: `${parsed.pathname}${parsed.search}`,
            headers: { ...headers, host: parsed.host },
            timeout: MAX_CONNECT_TIMEOUT_MS,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Upstream connection failed");
        });
        req.pipe(upstream);
      })();
    });

    nextServer.on("connection", trackSocket);

    nextServer.on("connect", (req, clientSocket, head) => {
      trackSocket(clientSocket);
      void (async () => {
        const target = parseAuthority(req.url ?? "");
        if (!target) {
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        const safeIp = await resolveSafeTarget(target.host, dnsLookup);
        if (!safeIp) {
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        const upstream = net.connect(target.port, safeIp, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        trackSocket(upstream);
        upstream.setTimeout(MAX_CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.on("error", () => {
          if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        });
        clientSocket.on("error", () => upstream.destroy());
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
    url = `http://127.0.0.1:${address.port}`;
  }

  const saved = await readSavedEnabled(options.userDataDir);
  if (saved) {
    try {
      await startServer();
      enabled = true;
    } catch {
      enabled = false;
      url = null;
    }
  }

  return {
    state: () => ({ enabled, url }),
    async setEnabled(next: boolean): Promise<RakazoDesktopProxyState> {
      if (next) {
        await startServer();
        enabled = true;
      } else {
        await stopServer();
        enabled = false;
      }
      await writeSavedEnabled(options.userDataDir, enabled);
      return { enabled, url };
    },
    async close(): Promise<void> {
      await stopServer();
      enabled = false;
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
