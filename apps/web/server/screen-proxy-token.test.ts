import { once } from "node:events";
import type { Server } from "node:http";
import { createServer as createHttpServer, request as httpRequestFn } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { ScreenCapabilityScope } from "@rakazo/core/node/screen-capability";
import {
  addScreenProxyCapability,
  openScreenCapability,
  SCREEN_TARGET_ENDPOINT,
} from "@rakazo/core/node/screen-capability";
import { deferred } from "@rakazo/core/test-async";
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
type Policy = "view" | "control";

function screenScope(policy: Policy): ScreenCapabilityScope {
  return {
    botId: "bot",
    computerId: "computer",
    botGeneration: 0,
    computerGeneration: 0,
    controlLeaseId: policy === "control" ? "fake-control-lease" : null,
  };
}

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
    socket.end(
      url.searchParams.get("token") === viewToken
        ? "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        : "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
    );
  });
  return server;
}

/**
 * The API's own answer for a screen path: it decrypts the capability and hands back its target. What
 * the real endpoint adds beyond this — the bot and computer still exist at the sealed generation, the
 * control lease still holds — is covered by its own tests in `apps/api/src/computers`.
 */
function screenAuthority() {
  return createHttpServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== SCREEN_TARGET_ENDPOINT ||
      req.headers.authorization !== `Bearer ${secret}`
    ) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { path } = JSON.parse(Buffer.concat(chunks).toString()) as { path: string };
    const capability = openScreenCapability(path, secret);
    if (!capability) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(capability.target));
  });
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

/** The status code of a plain GET for the path. */
function get(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  const answer = deferred<string>();
  httpRequestFn({ hostname, port, path, method: "GET" }, (response) => {
    answer.resolve(`${response.statusCode ?? 0}`);
    response.resume();
  })
    .on("error", (error) => answer.reject(error))
    .end();
  return answer.promise;
}

/**
 * The status line of a WebSocket upgrade for the path, sent verbatim: stock noVNC's socket path
 * starts with "//", which a browser sends as is and the proxy collapses, while a URL built from it
 * would read the second slash as another host.
 */
function upgrade(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  const answer = deferred<string>();
  const socket = connect(Number(port), hostname);
  let head = "";
  socket.on("data", (chunk: Buffer) => {
    head += chunk.toString("latin1");
    if (head.includes("\r\n")) answer.resolve(head.split("\r\n")[0]!);
  });
  socket.on("error", (error) => answer.reject(error));
  socket.on("close", () => answer.resolve(head.split("\r\n")[0] ?? ""));
  socket.end(
    `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  return answer.promise;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

/** The proxy the app serves, with its own authority and a provider screen behind it. */
async function startProxy() {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const screen = providerScreen(requests, upgrades);
  servers.push(screen);
  const screenOrigin = await listen(screen);
  const authority = screenAuthority();
  servers.push(authority);
  const authorityOrigin = await listen(authority);
  const chain: Middleware[] = [];
  const proxy = createHttpServer((req, res) => {
    let index = 0;
    const next = () => chain[index++]?.(req, res, next) ?? res.writeHead(404).end();
    next();
  });
  servers.push(proxy);
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
    publicOrigin: undefined,
    imageTag: "edge",
    appPolicy: "",
  };
  attachNovncProxy(host, settings);
  const origin = await listen(proxy);
  return { origin, screenOrigin, requests, upgrades };
}

/**
 * The provider URL the API seals. A team computer's supervisor hands over `embed.html` with the
 * token inside noVNC's `path` setting; other providers hand over `/vnc.html` and the adapter adds it.
 */
function providerUrl(screenOrigin: string, page: "embed.html" | "vnc.html", policy: Policy) {
  const url = new URL(`${screenOrigin}/${page}`);
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(viewToken)}`);
  url.searchParams.set("view_only", policy === "control" ? "false" : "true");
  return url.toString();
}

function screenPage(
  origin: string,
  screenOrigin: string,
  page: "embed.html" | "vnc.html",
  policy: Policy,
) {
  return new URL(
    addScreenProxyCapability(
      providerUrl(screenOrigin, page, policy),
      secret,
      origin,
      screenScope(policy),
      undefined,
    ),
  );
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

const shapes = ["embed.html", "vnc.html"] as const;
const policies = ["view", "control"] as const;

describe("screen proxy token carriage", () => {
  it.each(shapes.flatMap((shape) => policies.map((policy) => [shape, policy] as const)))(
    "forwards the sealed websockify token for a %s %s screen",
    async (shape, policy) => {
      const { origin, screenOrigin, requests, upgrades } = await startProxy();
      const page = screenPage(origin, screenOrigin, shape, policy);

      expect(await get(origin, `${page.pathname}${page.search}`)).toBe("200");

      // A plain request on the socket path is forwarded with the token too, not only the upgrade.
      const socketPath = shape === "embed.html" ? embedSocketPath(page) : novncSocketPath(page);
      expect(await get(origin, socketPath)).toBe("200");
      expect(requests.at(-1)).toBe(`/websockify?token=${viewToken}`);

      // websockify's TokenFile answers 404 to a socket without the token it was given.
      expect(await upgrade(origin, socketPath)).toBe("HTTP/1.1 101 Switching Protocols");
      expect(upgrades.at(-1)).toBe(`/websockify?token=${viewToken}`);
      if (policy === "control") expect(page.pathname).toContain("/novnc/session/control/");
    },
  );

  it.each(shapes)(
    "keeps the token out of everything the browser holds for a %s screen",
    async (shape) => {
      const { origin, screenOrigin } = await startProxy();
      const page = screenPage(origin, screenOrigin, shape, "view");
      // Whichever socket path the page builds, the token stays inside the capability it names.
      for (const value of [page.toString(), embedSocketPath(page), novncSocketPath(page)]) {
        expect(value).not.toContain(viewToken);
        expect(value).not.toContain("token");
      }
      if (shape === "embed.html") {
        expect(page.pathname).toBe(embedSocketPath(page).replace(/\/websockify$/, "/embed.html"));
      }
    },
  );

  it("refuses a socket naming a capability the authority will not open", async () => {
    const { origin, screenOrigin } = await startProxy();
    const page = screenPage(origin, screenOrigin, "embed.html", "view");
    // One changed character in the sealed token is enough for the authority to refuse.
    const socketPath = embedSocketPath(page).replace(
      /\.(.)/,
      (_, first: string) => `.${first === "a" ? "b" : "a"}`,
    );
    expect(await upgrade(origin, socketPath)).not.toContain("101");
  });
});
