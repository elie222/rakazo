import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect, isIP } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { Dispatcher } from "undici";
import { EnvHttpProxyAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { secureFetch } from "./mcp-transport.js";
import type { ResolveHostname } from "./network-address.js";
import { createTestTlsIdentity } from "./proxy-dispatcher.test-support.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import { dispatcherFetch } from "./undici-fetch.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

describe.each(["web", "remote"] as const)("%s proxy transport", (kind) => {
  let savedCas: string[];
  let identity: ReturnType<typeof createTestTlsIdentity>;
  let target: ReturnType<typeof createHttpsServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let sockets: Set<Socket>;
  let tunnels: { path: string; host: string }[];
  let requests: { host: string; authorization: string | undefined }[];
  let servernames: string[];
  let hostnameOnly: boolean;
  let url: string;

  beforeAll(() => {
    savedCas = getCACertificates();
    identity = createTestTlsIdentity();
    setDefaultCACertificates([...savedCas, identity.cert]);
  });
  afterAll(() => setDefaultCACertificates(savedCas));

  beforeEach(async () => {
    sockets = new Set();
    tunnels = [];
    requests = [];
    servernames = [];
    hostnameOnly = false;
    target = createHttpsServer(identity, (request, response) => {
      requests.push({
        host: request.headers.host ?? "",
        authorization: request.headers.authorization,
      });
      response.end("ok");
    });
    target.on("secureConnection", (socket) => servernames.push(socket.servername || ""));
    proxy = createHttpServer((_request, response) => response.writeHead(405).end());
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    };
    proxy.on("connect", (request, client, head) => {
      const path = request.url ?? "";
      tunnels.push({ path, host: request.headers.host ?? "" });
      const hostname = path.slice(0, path.lastIndexOf(":")).replace(/^\[|\]$/g, "");
      if (hostnameOnly && isIP(hostname)) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      // The proxy terminates every tunnel at our offline fixture, never at a real public IP.
      const upstream = connect((target.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client).pipe(upstream);
      });
      track(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    });
    for (const server of [target, proxy]) server.on("connection", track);
    await Promise.all(
      [target, proxy].map(
        (server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)),
      ),
    );
    url = `https://proxy.example.test:${(target.address() as AddressInfo).port}/test`;
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      vi.stubEnv(name, proxyUrl);
    }
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("RAKAZO_PROXY_CONNECT_BY_HOSTNAME", "false");
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map((server) => new Promise((done) => server.close(done))));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function request(
    endpoint = url,
    resolve = publicResolver,
    allowPrivateEndpoint = false,
  ): Promise<string> {
    const headers = { authorization: "Bearer fake-proxy-test-credential" };
    if (kind === "web") {
      return (
        await fetchSafeWebText(endpoint, { headers, resolveHostname: resolve, timeoutMs: 2000 })
      ).body;
    }
    const fetch = createSafeRemoteFetch(undefined, resolve, { allowPrivateEndpoint });
    try {
      return await (await fetch(endpoint, { headers, signal: AbortSignal.timeout(2000) })).text();
    } finally {
      await fetch.close();
    }
  }

  it("pins CONNECT to the checked IP and preserves the HTTPS host, SNI and credential", async () => {
    expect(await request()).toBe("ok");
    const authority = `203.0.113.10:${new URL(url).port}`;
    expect(tunnels).toEqual([{ path: authority, host: authority }]);
    expect(servernames).toEqual(["proxy.example.test"]);
    expect(requests).toEqual([
      { host: new URL(url).host, authorization: "Bearer fake-proxy-test-credential" },
    ]);
  });

  it("supports a hostname-only proxy with the explicit opt-in", async () => {
    hostnameOnly = true;
    vi.stubEnv("RAKAZO_PROXY_CONNECT_BY_HOSTNAME", "true");
    expect(await request()).toBe("ok");
    expect(tunnels).toEqual([{ path: new URL(url).host, host: new URL(url).host }]);
    expect(servernames).toEqual(["proxy.example.test"]);
    expect(requests[0]?.authorization).toBe("Bearer fake-proxy-test-credential");
  });

  it("still rechecks DNS before hostname CONNECT", async () => {
    vi.stubEnv("RAKAZO_PROXY_CONNECT_BY_HOSTNAME", "true");
    let calls = 0;
    const resolve: ResolveHostname = async () => [
      { address: calls++ === 0 ? "203.0.113.10" : "127.0.0.1", family: 4 },
    ];
    await expect(request(url, resolve, kind === "remote")).rejects.toThrow();
    expect(tunnels).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("keeps the checked lookup when NO_PROXY bypasses the proxy", async () => {
    vi.stubEnv("no_proxy", "proxy.example.test");
    vi.stubEnv("RAKAZO_PROXY_CONNECT_BY_HOSTNAME", "true");
    let calls = 0;
    await expect(
      request(url, async () => [
        { address: calls++ === 0 ? "203.0.113.10" : "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
    expect(tunnels).toEqual([]);
    expect(requests).toEqual([]);
  });

  if (kind === "remote") {
    it("formats checked IPv6 CONNECT authorities", async () => {
      expect(await request(url, async () => [{ address: "2606:4700:4700::1111", family: 6 }])).toBe(
        "ok",
      );
      const authority = `[2606:4700:4700::1111]:${new URL(url).port}`;
      expect(tunnels).toEqual([{ path: authority, host: authority }]);
    });

    it("keeps an authorized private MCP endpoint direct without NO_PROXY", async () => {
      const endpoint = url.replace("proxy.example.test", "private.example.test");
      const resolve: ResolveHostname = async () => [{ address: "127.0.0.1", family: 4 }];
      expect(await request(endpoint, resolve, true)).toBe("ok");
      expect(tunnels).toEqual([]);
      expect(requests).toHaveLength(1);
    });

    it("keeps local OAuth credentials direct with a proxy-aware global fetch", async () => {
      let authorization: string | undefined;
      const server = createHttpServer((incoming, response) => {
        authorization = incoming.headers.authorization;
        response.end("direct");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      // Model the proxy-aware global fetch installed by NODE_USE_ENV_PROXY=1.
      const ambientDispatcher = new EnvHttpProxyAgent();
      const proxyAwareFetch = vi.fn<typeof globalThis.fetch>((input, init) =>
        dispatcherFetch(input, {
          ...init,
          dispatcher: ambientDispatcher,
        } as RequestInit & { dispatcher: Dispatcher }),
      );
      vi.stubGlobal("fetch", proxyAwareFetch);
      const endpoint = new URL(`http://localhost:${(server.address() as AddressInfo).port}/token`);
      const fetch = secureFetch(
        endpoint,
        { allowHttpLocalhost: true, allowPrivateEndpoint: true, allowLocalHttpCredentials: true },
        {},
        { resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] },
      );
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: "Bearer fake-proxy-test-credential" },
          signal: AbortSignal.timeout(2000),
        });
        expect(await response.text()).toBe("direct");
        expect(authorization).toBe("Bearer fake-proxy-test-credential");
        expect(proxyAwareFetch).not.toHaveBeenCalled();
        expect(tunnels).toEqual([]);
      } finally {
        await fetch.close();
        await ambientDispatcher.close();
        await new Promise((done) => server.close(done));
      }
    });
  }
});
