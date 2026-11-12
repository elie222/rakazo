import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createWebServer } from "./standalone-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

async function start() {
  const api = http.createServer((req, res) =>
    res.end(JSON.stringify({ url: req.url, headers: req.headers })),
  );
  api.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  const apiPort = await listen(api);
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-standalone-web-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(root, "dist", "assets", "app-1.js"), "export {};");
  await writeFile(path.join(root, "dist", "build-id"), "test\n");
  const web = createWebServer(root, {
    API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    RAKAZO_HOST: "app.example.test",
    SCREEN_PROXY_SECRET: "test-screen-proxy-secret-0123456789abcdef",
  });
  return listen(web);
}

function get(port: number, pathname: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: pathname, headers }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
        })
        .on("error", reject);
    },
  );
}

function upgrade(port: number, host: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: USER_DEVICE_CONNECT_PATH,
      headers: { Host: host, Connection: "Upgrade", Upgrade: "websocket" },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("standalone web server", () => {
  it("serves the app with the preview server's headers and SPA fallback", async () => {
    const port = await start();

    const page = await get(port, "/chat/1", { accept: "text/html" });
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>app</title>");
    expect(page.headers["content-security-policy"]).toContain("default-src");
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");

    const script = await get(port, "/assets/app-1.js");
    expect(script.headers["content-type"]).toBe("text/javascript");
    expect((await get(port, "/assets/gone.js")).status).toBe(404);
    expect((await get(port, "/p/shared")).headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect((await get(port, "/", { host: "evil.example" })).status).toBe(403);
  });

  it("forwards API requests with the hop it saw", async () => {
    const port = await start();

    const forwarded = await get(port, "/rpc/ping?x=1", { "x-forwarded-for": "203.0.113.9" });
    const echoed = JSON.parse(forwarded.body) as { url: string; headers: http.IncomingHttpHeaders };
    expect(echoed.url).toBe("/rpc/ping?x=1");
    expect(echoed.headers["x-forwarded-for"]).toBe("203.0.113.9, 127.0.0.1");
    expect(JSON.parse((await get(port, "/api/auth/ok")).body).url).toBe("/api/auth/ok");
  });

  it("forwards the device socket only for allowed hosts", async () => {
    const port = await start();

    await expect(upgrade(port, "app.example.test")).resolves.toBe(101);
    await expect(upgrade(port, "evil.example")).resolves.toBe(404);
  });
});
