import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, type Plugin, preview, type ViteDevServer } from "vite";
import { addScreenProxyCapability } from "../../api/src/screen-proxy";

const secret = "fake-screen-proxy-browser-test-secret";
const screenHtml = `<!doctype html><title>Fake screen</title>
<script type="module">
  import { loaded } from './core/rfb.js';
  const attempt = (read) => { try { return read(); } catch { return 'blocked'; } };
  const result = {
    asset: loaded,
    cookie: attempt(() => document.cookie),
    storage: attempt(() => localStorage.getItem('app-data')),
    parent: attempt(() => parent.document.title),
    api: await fetch('/session', { credentials: 'include' }).then(r => r.text()).catch(() => 'blocked'),
  };
  const socketUrl = new URL('./websockify', location.href);
  socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl);
  socket.onmessage = (event) => {
    result.socket = event.data;
    socket.close();
    document.body.textContent = JSON.stringify(result);
  };
</script><body></body>`;

async function listen(server: NetServer) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

for (const mode of ["development", "preview"] as const) {
  test.describe(`screen response isolation in ${mode}`, () => {
    let origin: string;
    let screenUrl: string;
    let stop: () => Promise<void>;

    test.beforeAll(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-screen-test-"));
      await mkdir(path.join(root, "dist"));
      const upstream = createHttpServer((req, res) => {
        // Even a listener explicitly requesting same-origin access cannot loosen the proxy policy.
        res.setHeader(
          "Content-Security-Policy",
          `sandbox allow-scripts allow-same-origin allow-pointer-lock; frame-ancestors ${origin}`,
        );
        res.setHeader("Set-Cookie", "app-session=attacker; Path=/");
        if (req.url === "/core/rfb.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end('export const loaded = "module loaded";');
        } else {
          res.setHeader("Content-Type", "text/html");
          res.end(screenHtml);
        }
      });
      upstream.on("upgrade", (req, socket) => {
        const accept = createHash("sha1")
          .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: app-session=attacker; Path=/\r\n\r\n`,
        );
        socket.write(Buffer.from([0x81, 2, 111, 107]));
        socket.on("data", () => socket.end(Buffer.from([0x88, 0])));
        socket.on("error", () => socket.destroy());
      });
      const upstreamOrigin = await listen(upstream);

      const appFixture: Plugin = {
        name: "fake-app-origin",
        configureServer: installApp,
        configurePreviewServer: installApp,
      };
      function installApp(server: Pick<ViteDevServer, "middlewares">) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/app") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<!doctype html><title>Fake app</title><body><script>localStorage.setItem("app-data", "private-app-data"); document.cookie = "app-session=fake-session; Path=/";</script></body>',
            );
          } else if (req.url === "/session") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
          } else next();
        });
      }
      const previousSecret = process.env.SCREEN_PROXY_SECRET;
      process.env.SCREEN_PROXY_SECRET = secret;
      try {
        // Load the real configuration: both production and development hooks must install the policy.
        const config = {
          root,
          configFile: path.resolve(import.meta.dirname, "../vite.config.ts"),
          mode: "test",
          plugins: [appFixture],
          logLevel: "silent" as const,
          server: { host: "127.0.0.1", port: 0, hmr: false as const },
          preview: { host: "127.0.0.1", port: 0 },
        };
        const server = mode === "development" ? await createServer(config) : await preview(config);
        // listen() replaces zero with Vite's default port; bind the HTTP server directly instead.
        if ("listen" in server) await listen(server.httpServer!);
        origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
        // Exercise the same capability issuer used by the production API, with a configured web origin.
        screenUrl = addScreenProxyCapability(`${upstreamOrigin}/embed.html`, secret, origin);
        stop = async () => {
          await server.close();
          await close(upstream);
          await rm(root, { recursive: true, force: true });
        };
      } finally {
        if (previousSecret === undefined) delete process.env.SCREEN_PROXY_SECRET;
        else process.env.SCREEN_PROXY_SECRET = previousSecret;
      }
    });

    test.afterAll(async () => {
      await stop?.();
    });

    test("direct navigation cannot read application data while assets and WebSockets work", async ({
      page,
    }) => {
      await page.goto(`${origin}/app`);
      const response = await page.goto(screenUrl);
      await expect(page.locator("body")).toContainText('"socket":"ok"');
      const result = JSON.parse(await page.locator("body").innerText());
      expect(result).toMatchObject({
        asset: "module loaded",
        socket: "ok",
        cookie: "blocked",
        storage: "blocked",
        api: "blocked",
      });
      expect(response?.headers()["content-security-policy"]).toContain(
        "sandbox allow-scripts allow-pointer-lock",
      );
      expect(
        (await page.context().cookies(origin)).find((c) => c.name === "app-session")?.value,
      ).toBe("fake-session");
    });

    for (const sandbox of ["allow-scripts allow-pointer-lock", null]) {
      test(`iframe remains isolated with sandbox attribute ${sandbox ?? "absent"}`, async ({
        page,
      }) => {
        await page.goto(`${origin}/app`);
        await page.evaluate(
          ({ url, sandbox }) => {
            const frame = document.createElement("iframe");
            if (sandbox !== null) frame.setAttribute("sandbox", sandbox);
            frame.src = url;
            document.body.append(frame);
          },
          { url: screenUrl, sandbox },
        );
        const body = page.frameLocator("iframe").locator("body");
        await expect(body).toContainText('"socket":"ok"');
        expect(JSON.parse(await body.innerText())).toEqual({
          asset: "module loaded",
          socket: "ok",
          cookie: "blocked",
          storage: "blocked",
          parent: "blocked",
          api: "blocked",
        });
      });
    }
  });
}
