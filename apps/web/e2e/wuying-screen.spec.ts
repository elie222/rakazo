import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { contentSecurityPolicyFor } from "@rakazo/contracts/content-security-policy";

test("the isolated Wuying runtime loads its decoder and connects to a gateway port", async ({
  page,
}) => {
  const publicDir = path.resolve(import.meta.dirname, "../public/wuying");
  const sdk = `window.Wuying = { WebSDK: { createSession: (_id, options) => ({
    addHandle() {}, enableInput() {}, stop() {},
    start() { document.getElementById(options.iframeId).src = './sdk/ASP/container.html'; }
  }) } };`;
  const mqttUrl = "https://o.alicdn.com/aliyun-ecs/eds-cdn/paho-mqtt/mqttws31.min.js";
  const runtime = `document.addEventListener('DOMContentLoaded', async () => {
    try {
      const decoder = await fetch('data:application/wasm;base64,AGFzbQEAAAA=');
      await WebAssembly.compile(await decoder.arrayBuffer());
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ${JSON.stringify(mqttUrl)};
        script.onload = resolve;
        script.onerror = reject;
        document.body.append(script);
      });
      const socket = new WebSocket('wss://test.wuying.aliyuncs.com:8008/websocket');
      socket.onmessage = async () => {
        let isolated = false;
        try { parent.document.title; } catch { isolated = true; }
        const privateApi = await fetch('/api/private', { credentials: 'include' })
          .then(() => 'accessible', () => 'blocked');
        document.body.textContent = JSON.stringify({ connected: true, isolated, privateApi });
        socket.close();
      };
    } catch { document.body.textContent = 'Runtime failed to load'; }
  });`;
  await page.route(mqttUrl, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "/* Offline gateway dependency. */" }),
  );
  await page.routeWebSocket("wss://test.wuying.aliyuncs.com:8008/websocket", (socket) => {
    socket.send("connected");
  });
  const routes: Record<string, [string, string]> = {
    "/app": [
      "text/html",
      '<!doctype html><iframe id="screen" sandbox="allow-scripts allow-pointer-lock" src="/wuying/screen.html#desktop_id=ecd-fake&auth_code=fake"></iframe>',
    ],
    "/wuying/screen.html": ["text/html", readFileSync(path.join(publicDir, "screen.html"), "utf8")],
    "/wuying/storage.js": [
      "text/javascript",
      readFileSync(path.join(publicDir, "storage.js"), "utf8"),
    ],
    "/wuying/screen.js": [
      "text/javascript",
      readFileSync(path.join(publicDir, "screen.js"), "utf8"),
    ],
    "/wuying/WuyingWebSDK.js": ["text/javascript", sdk],
    "/wuying/sdk/ASP/container.html": [
      "text/html",
      '<!doctype html><script src="/wuying/runtime.js"></script><body></body>',
    ],
    "/wuying/runtime.js": ["text/javascript", runtime],
  };
  const errors: string[] = [];
  const privateApiRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/private") privateApiRequests.push(pathname);
    const route = routes[pathname];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", route[0]);
    const policy = contentSecurityPolicyFor(pathname);
    if (policy) response.setHeader("Content-Security-Policy", policy);
    response.end(route[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/app`);
    await expect(
      page.frameLocator("#screen").frameLocator("#session").locator("body"),
      errors.join("\n"),
    ).toHaveText(JSON.stringify({ connected: true, isolated: true, privateApi: "blocked" }), {
      timeout: 5000,
    });
    expect(privateApiRequests).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
