import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveHostname } from "./network-address.js";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./proxy-dispatcher.test-support.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

describe.each(["web", "remote"] as const)("%s proxy transport", (kind) => {
  let savedCas: string[];
  let target: ReturnType<typeof createHttpsServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let sockets: Set<Socket>;
  let tunnels: { path: string; host: string }[];
  let requests: { host: string; authorization: string | undefined }[];
  let servernames: string[];
  let url: string;

  beforeAll(() => {
    savedCas = getCACertificates();
    setDefaultCACertificates([...savedCas, TEST_TLS_CERT]);
  });
  afterAll(() => setDefaultCACertificates(savedCas));

  beforeEach(async () => {
    sockets = new Set();
    tunnels = [];
    requests = [];
    servernames = [];
    target = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (request, response) => {
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
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map((server) => new Promise((done) => server.close(done))));
    vi.unstubAllEnvs();
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

  it("keeps the checked lookup when NO_PROXY bypasses the proxy", async () => {
    vi.stubEnv("no_proxy", "proxy.example.test");
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

    it("keeps an authorized private MCP endpoint in NO_PROXY direct", async () => {
      vi.stubEnv("no_proxy", "localhost");
      const endpoint = url.replace("proxy.example.test", "localhost");
      const resolve: ResolveHostname = async () => [{ address: "127.0.0.1", family: 4 }];
      expect(await request(endpoint, resolve, true)).toBe("ok");
      expect(tunnels).toEqual([]);
      expect(requests).toHaveLength(1);
    });
  }
});
