import type { Server } from "node:http";
import { createServer as createHttpServer, request as httpRequestFn } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { ScreenCapabilityScope } from "@rakazo/core/node/screen-capability";
import {
  addScreenProxyCapability,
  openScreenCapability,
} from "@rakazo/core/node/screen-capability";
import type { Logger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { Middleware, WebServerHost, WebServerSettings } from "./preview-middleware.js";
import { attachNovncProxy } from "./preview-middleware.js";

/**
 * A team computer's websockify runs with `--token-plugin=TokenFile`, so it answers 404 to a socket
 * that names no token in its mapping directory. The capability seals the provider's tokened URL and
 * nothing token-shaped reaches the browser, so the proxy is what has to put the sealed token back on
 * the forwarded request.
 */
const secret = "fake-screen-proxy-token-secret-0123456789";
const viewToken = "fake-team-computer-view-token";
const scope: ScreenCapabilityScope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: null,
};

const logger: Logger = {
  level: "error",
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withContext: (_bindings, fn) => fn(),
  enrich: () => undefined,
  flush: async () => undefined,
};

/** A provider screen whose socket behaves like websockify with TokenFile: a wrong token is a 404. */
function providerScreen(requests: string[], upgrades: string[]) {
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? "/");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>Fake screen</title>");
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://screen.invalid");
    upgrades.push(`${url.pathname}${url.search}`);
    const mapping = url.searchParams.get("token") === viewToken;
    socket.end(
      mapping
        ? "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        : "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
    );
  });
  return server;
}

/** The API's own answer for a screen path: the decrypted target, or a refusal. */
function screenAuthority() {
  return createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { path } = JSON.parse(Buffer.concat(chunks).toString()) as { path: string };
    const capability = openScreenCapability(path, secret);
    if (!capability || req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(capability.target));
  });
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/**
 * A request with the path exactly as the page sends it. Stock noVNC's socket path starts with "//",
 * which a browser sends verbatim and the proxy collapses; `new URL` would read it as another host.
 */
function rawRequest(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  return httpRequest({ hostname, port, path, method: "GET" });
}

function httpRequest(
  options: { hostname: string; port: string; path: string; method: string },
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequestFn({ ...options, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

function send(origin: string, path: string) {
  const url = new URL(origin);
  const client = connect(Number(url.port), url.hostname);
  const answer = new Promise<string>((resolve) => {
    let head = "";
    client.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n")) resolve(head.split("\r\n")[0]!);
    });
    client.on("error", () => resolve("client error"));
    client.end(
      `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
  });
  return answer.finally(() => client.destroy());
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

/**
 * The proxy the app serves, with its own authority and a provider screen behind it.
 */
async function startProxy() {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const screen = providerScreen(requests, upgrades);
  const screenOrigin = await listen(screen);
  const authority = screenAuthority();
  const authorityOrigin = await listen(authority);
  const chain: Middleware[] = [];
  const proxy = createHttpServer((req, res) => {
    let index = 0;
    const next = () => chain[index++]?.(req, res, next) ?? res.writeHead(404).end();
    next();
  });
  const host: WebServerHost = {
    middlewares: { use: (handler) => chain.push(handler) },
    httpServer: proxy,
  };
  const settings: WebServerSettings = {
    log: logger,
    api: authorityOrigin,
    allowedHosts: [],
    screenProxySecret: () => secret,
    performanceAssetDelayMs: 0,
    desktopStackToken: "",
    instanceTheme: undefined,
    imageTag: "edge",
    appPolicy: "",
  };
  attachNovncProxy(host, settings);
  const origin = await listen(proxy);
  servers.push(screen, authority, proxy);
  return { origin, screenOrigin, requests, upgrades };
}

/**
 * The provider URL the API seals. A team computer's supervisor hands over `embed.html` with the
 * token inside noVNC's `path` setting; other providers hand over `/vnc.html` and the adapter adds it.
 */
function providerUrl(screenOrigin: string, page: "embed.html" | "vnc.html") {
  const url = new URL(`${screenOrigin}/${page}`);
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(viewToken)}`);
  url.searchParams.set("view_only", "true");
  return url.toString();
}

/** How the shipped embed page builds its socket: the capability prefix plus noVNC's `path`. */
function embedSocketPath(page: URL) {
  const prefix = page.pathname.replace(/[^/]+$/, "");
  return `${prefix}${page.searchParams.get("path") ?? "websockify"}`;
}

/** How stock noVNC builds its socket: host, then "/", then the absolute `path` setting. */
function novncSocketPath(page: URL) {
  return `/${page.searchParams.get("path")}`;
}

describe("screen proxy token carriage", () => {
  it.each(["embed.html", "vnc.html"] as const)(
    "forwards the sealed websockify token for a %s screen",
    async (shape) => {
      const { origin, screenOrigin, requests, upgrades } = await startProxy();
      const page = new URL(
        addScreenProxyCapability(
          providerUrl(screenOrigin, shape),
          secret,
          origin,
          scope,
          undefined,
        ),
      );

      const response = await fetch(page);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Fake screen");

      // A plain request on the socket path is forwarded with the token too, not only the upgrade.
      const socketPath = shape === "embed.html" ? embedSocketPath(page) : novncSocketPath(page);
      const plain = await rawRequest(origin, socketPath);
      expect(plain.status).toBe(200);
      expect(requests.at(-1)).toBe(`/websockify?token=${viewToken}`);

      // websockify's TokenFile answers 404 to a socket without the token it was given.
      expect(await send(origin, socketPath)).toBe("HTTP/1.1 101 Switching Protocols");
      expect(upgrades.at(-1)).toBe(`/websockify?token=${viewToken}`);
    },
  );

  it.each(["embed.html", "vnc.html"] as const)(
    "keeps the token out of everything the browser holds for a %s screen",
    async (shape) => {
      const { origin, screenOrigin } = await startProxy();
      const page = new URL(
        addScreenProxyCapability(
          providerUrl(screenOrigin, shape),
          secret,
          origin,
          scope,
          undefined,
        ),
      );
      // Whichever socket path the page builds, the token stays inside the capability it names.
      const held = [page.toString(), embedSocketPath(page), novncSocketPath(page)];
      for (const value of held) {
        expect(value).not.toContain(viewToken);
        expect(value).not.toContain("token");
      }
      if (shape === "embed.html") {
        expect(page.pathname).toBe(embedSocketPath(page).replace(/\/websockify$/, "/embed.html"));
      }
    },
  );
});
