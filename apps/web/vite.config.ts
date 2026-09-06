import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { lingui } from "@lingui/vite-plugin";
import type { DesktopStackProbeResponse } from "@rakazo/contracts";
import {
  safeScreenProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "@rakazo/core/node/screen-proxy-response";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from "vite";
import { resolveScreenProxySecret } from "../../packages/core/src/secrets-guard.ts";
import { resolveNovncTarget, safeProxyHeaders } from "./src/screen-proxy.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const DESKTOP_STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";

function equalStackToken(expected: string, supplied: string | string[] | undefined) {
  if (expected === "" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function attachDesktopStackProbe(
  server: ViteDevServer | PreviewServer,
  token: string,
  imageTag: string,
) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split("?", 1)[0] !== DESKTOP_STACK_PROBE_PATH) {
      next();
      return;
    }
    if (!equalStackToken(token, req.headers[DESKTOP_STACK_TOKEN_HEADER])) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const body: DesktopStackProbeResponse = { ok: true, imageTag };
    res.statusCode = 200;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  });
}

function attachNovncProxy(server: ViteDevServer | PreviewServer, secret: string) {
  server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/novnc/")) {
      next();
      return;
    }
    const target = resolveNovncTarget(req.url, secret);
    if (!target) {
      res.statusCode = 403;
      res.end("Invalid or expired screen capability");
      return;
    }
    const headers = {
      ...safeProxyHeaders(req.headers),
      host: `${target.hostname}:${target.port}`,
    };
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: req.method,
        headers,
        ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
      },
      (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, safeScreenProxyResponseHeaders(incoming.headers));
        incoming.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.statusCode = 502;
      res.end(error.message);
    });
    req.pipe(upstream);
  });

  server.httpServer?.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/novnc/")) return;
    const target = resolveNovncTarget(req.url, secret);
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream =
      target.protocol === "https:"
        ? tls.connect({ port: target.port, host: target.hostname, servername: target.hostname })
        : net.connect(target.port, target.hostname);
    upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      const headerLines = [
        `${req.method ?? "GET"} ${target.path} HTTP/1.1`,
        `Host: ${target.hostname}:${target.port}`,
      ];
      for (const [key, value] of Object.entries(safeProxyHeaders(req.headers))) {
        headerLines.push(`${key}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      let responseTail = Buffer.alloc(0);
      const forwardHandshake = (chunk: Buffer) => {
        responseChunks.push(chunk);
        responseSize += chunk.length;
        if (responseSize > 64 * 1024) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        const boundarySearch = Buffer.concat([responseTail, chunk]);
        if (boundarySearch.indexOf("\r\n\r\n") < 0) {
          responseTail = Buffer.from(boundarySearch.subarray(-3));
          return;
        }
        const responseHead = Buffer.concat(responseChunks, responseSize);
        const safe = stripSensitiveHandshakeHeaders(responseHead);
        if (!safe) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        upstream.off("data", forwardHandshake);
        socket.write(safe);
        upstream.pipe(socket);
      };
      upstream.on("data", forwardHandshake);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const previewHost = process.env.RAKAZO_HOST ?? rootEnv.RAKAZO_HOST ?? "localhost";
  const screenProxySecret = () =>
    resolveScreenProxySecret({
      ...process.env,
      SCREEN_PROXY_SECRET: process.env.SCREEN_PROXY_SECRET ?? rootEnv.SCREEN_PROXY_SECRET,
      SANDBOX_SUPERVISOR_TOKEN:
        process.env.SANDBOX_SUPERVISOR_TOKEN ?? rootEnv.SANDBOX_SUPERVISOR_TOKEN,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? rootEnv.BETTER_AUTH_SECRET,
    });
  const performanceAssetDelayMs = Number(process.env.RAKAZO_PERFORMANCE_ASSET_DELAY_MS ?? 0);
  const desktopStackToken =
    process.env.RAKAZO_DESKTOP_STACK_TOKEN ?? rootEnv.RAKAZO_DESKTOP_STACK_TOKEN ?? "";
  const imageTag = process.env.RAKAZO_IMAGE_TAG ?? rootEnv.RAKAZO_IMAGE_TAG ?? "edge";
  return {
    plugins: [
      react({
        babel: {
          plugins: ["@lingui/babel-plugin-lingui-macro"],
        },
      }),
      lingui(),
      tailwindcss(),
      {
        name: "rakazo-desktop-stack-probe",
        configureServer: (server) => attachDesktopStackProbe(server, desktopStackToken, imageTag),
        configurePreviewServer: (server) =>
          attachDesktopStackProbe(server, desktopStackToken, imageTag),
      },
      {
        name: "rakazo-performance-asset-delay",
        configurePreviewServer(server) {
          if (!Number.isFinite(performanceAssetDelayMs) || performanceAssetDelayMs <= 0) return;
          server.middlewares.use((req, _res, next) => {
            const pathname = req.url?.split("?", 1)[0] ?? "/";
            if (["/api", "/rpc", "/novnc"].some((prefix) => pathname.startsWith(prefix))) {
              next();
              return;
            }
            setTimeout(next, performanceAssetDelayMs);
          });
        },
      },
      {
        name: "rakazo-novnc-proxy",
        configureServer: (server) => attachNovncProxy(server, screenProxySecret()),
        configurePreviewServer: (server) => attachNovncProxy(server, screenProxySecret()),
      },
    ],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: api, changeOrigin: true },
        "/rpc": { target: api, changeOrigin: true },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: Number(process.env.WEB_PORT ?? 5173),
      allowedHosts: [previewHost],
      proxy: {
        "/api": { target: api, changeOrigin: true },
        "/rpc": { target: api, changeOrigin: true },
      },
    },
  };
});
