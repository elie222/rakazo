import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { lingui } from "@lingui/vite-plugin";
import type { DesktopStackProbeResponse } from "@rakazo/contracts";
import { buildIdAt } from "@rakazo/contracts/client-build";
import {
  appContentSecurityPolicy,
  CSP_REPORTING_ENDPOINTS,
  contentSecurityPolicyFor,
  parseContentSecuritySources,
  parseCrispWebsiteId,
} from "@rakazo/contracts/content-security-policy";
import {
  safeScreenProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "@rakazo/core/node/screen-proxy-response";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PreviewServer, ViteDevServer } from "vite";
import { defineConfig, loadEnv } from "vite";
import { resolveScreenProxySecret } from "../../packages/core/src/secrets-guard.ts";
import { createServiceLogger } from "../../packages/logging/src/env.ts";
import { apiProxy } from "./src/api-proxy.js";
import { ASSET_ARCHIVE_DIR, archiveAssets } from "./src/asset-archive.js";
import { missingAssetMiddleware } from "./src/missing-asset.js";
import {
  collectNovncHtml,
  injectNovncStorageShim,
  isNovncPage,
  MAX_NOVNC_HTML_BYTES,
  novncPageRequestHeaders,
  rewrittenNovncHeaders,
  shouldInjectNovncStorageShim,
} from "./src/novnc-html.js";
import { rakazoPwa } from "./src/pwa/plugin.js";
import type { ScreenTargetFailure } from "./src/screen-proxy.js";
import {
  checkScreenAuthorization,
  novncRequestPath,
  resolveNovncTarget,
  safeProxyHeaders,
  screenCapabilityExpiry,
  screenProbePath,
  screenProbeStatus,
  screenRefusal,
  screenUpstreamReachable,
  watchScreenAuthorization,
} from "./src/screen-proxy.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const DESKTOP_STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
const SCREEN_UPSTREAM_TIMEOUT_MS = 20_000;
const screenLog = createServiceLogger({ service: "rakazo-web" });

function screenPolicy(url: string | undefined) {
  return url?.startsWith("/novnc/session/control/") ? "control" : "view";
}

function socketErrorCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

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

function attachNovncProxy(server: ViteDevServer | PreviewServer, secret: string, api: string) {
  server.middlewares.use(async (req, res, next) => {
    const path = novncRequestPath(req.url);
    if (!path) {
      next();
      return;
    }
    req.url = path;
    const connectionId = randomUUID();
    const bindings = {
      "screen.connection_id": connectionId,
      "screen.policy": screenPolicy(req.url),
    };
    const confirmedAt = performance.now();
    // A status-only probe is answered here, after the same access check, and never forwarded.
    const probe = screenProbePath(req.url);
    let refusal: ScreenTargetFailure | undefined;
    const target = await resolveNovncTarget(probe ?? req.url, secret, api, (reason) => {
      refusal = reason;
      screenLog.warn("screen.proxy.target_rejected", {
        ...bindings,
        "screen.transport": "http",
        reason,
      });
    });
    if (res.destroyed) return;
    if (probe) {
      // Only a connection attempt reaches the computer; the proxy writes the whole answer.
      const reachable = target ? await screenUpstreamReachable(target) : false;
      if (res.destroyed) return;
      res.statusCode = screenProbeStatus(target, refusal, reachable);
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }
    if (!target) {
      const { status, body } = screenRefusal(refusal);
      res.statusCode = status;
      res.end(body);
      return;
    }
    const forwarded = safeProxyHeaders(req.headers, target);
    const headers = {
      // The storage shim rewrites the page, so ask for all of it, uncompressed.
      ...(isNovncPage(target.path) ? novncPageRequestHeaders(forwarded) : forwarded),
      host: `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
    };
    const transport = target.protocol === "https:" ? https : http;
    let upstream: ClientRequest | undefined;
    let retries = 0;
    let retryPending = false;
    let stopChecking: () => void = () => undefined;
    const retryable = req.method === "GET";
    const scheduleRetry = (incoming?: IncomingMessage) => {
      if (!retryable || retryPending || retries >= 3 || res.destroyed) return false;
      retryPending = true;
      retries += 1;
      const delayMs = 50 * retries;
      const retry = () => {
        setTimeout(() => {
          retryPending = false;
          if (!res.destroyed) requestUpstream();
        }, delayMs);
      };
      if (incoming && !incoming.destroyed) {
        incoming.once("close", retry);
        incoming.destroy();
      } else {
        retry();
      }
      return true;
    };
    let downstreamFinished = false;
    const finishUnavailable = (reason: string, errorCode?: string) => {
      if (downstreamFinished || res.destroyed || res.writableEnded) return;
      downstreamFinished = true;
      screenLog.warn("screen.proxy.http_failed", {
        ...bindings,
        reason,
        ...(errorCode ? { "error.code": errorCode } : {}),
      });
      stopChecking();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 502;
      res.end(`Screen unavailable (${reason})`);
    };
    function requestUpstream() {
      if (res.destroyed) return;
      upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: req.method,
          headers,
          ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        },
        (incoming) => {
          if ((incoming.statusCode ?? 502) >= 500 && scheduleRetry(incoming)) {
            return;
          }
          if ((incoming.statusCode ?? 502) >= 400) {
            screenLog.warn("screen.proxy.http_upstream_response", {
              ...bindings,
              "http.status": incoming.statusCode ?? 502,
              "screen.retries": retries,
            });
          }
          const responseHeaders = safeScreenProxyResponseHeaders(incoming.headers);
          if (shouldInjectNovncStorageShim(responseHeaders, target.path)) {
            const declaredLength = Number(incoming.headers["content-length"] ?? 0);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_NOVNC_HTML_BYTES) {
              finishUnavailable("html_too_large");
              incoming.destroy();
              return;
            }
            void collectNovncHtml(incoming, MAX_NOVNC_HTML_BYTES)
              .then((html) => {
                if (downstreamFinished || res.destroyed || res.writableEnded) return;
                downstreamFinished = true;
                const body = injectNovncStorageShim(html, { viewOnly: !target.interactive });
                res.writeHead(incoming.statusCode ?? 502, rewrittenNovncHeaders(responseHeaders));
                res.end(body);
              })
              .catch(() => {
                finishUnavailable("html_read_failed");
              });
            return;
          }
          res.writeHead(incoming.statusCode ?? 502, responseHeaders);
          incoming.pipe(res);
        },
      );
      // A silent upstream would leave the frame blank for as long as the browser waits. The limit
      // covers only the wait for response headers; a slow or idle body after that keeps flowing.
      const request = upstream;
      const headersTimer = setTimeout(() => {
        finishUnavailable("upstream_timeout");
        request.destroy();
      }, SCREEN_UPSTREAM_TIMEOUT_MS);
      request.once("response", () => clearTimeout(headersTimer));
      request.once("close", () => clearTimeout(headersTimer));
      upstream.on("error", (error) => {
        if (
          retryable &&
          !downstreamFinished &&
          !res.headersSent &&
          !res.destroyed &&
          (retryPending || scheduleRetry())
        ) {
          return;
        }
        finishUnavailable("upstream_error", socketErrorCode(error));
      });
      if (req.method === "GET" || req.readableEnded) upstream.end();
      else req.pipe(upstream);
    }
    stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(req.url, secret, api, target),
      (reason) => {
        screenLog.warn("screen.proxy.http_revoked", {
          ...bindings,
          "screen.revoke_reason": reason,
        });
        upstream?.destroy();
        res.destroy();
      },
      {
        confirmedAt,
        expiresAt: screenCapabilityExpiry(req.url),
        onUnavailable: (consecutive) =>
          screenLog.warn("screen.proxy.recheck_unavailable", {
            ...bindings,
            "screen.transport": "http",
            "screen.consecutive": consecutive,
          }),
      },
    );
    res.once("close", () => {
      stopChecking();
      upstream?.destroy();
    });
    requestUpstream();
  });

  server.httpServer?.on("upgrade", async (req, socket, head) => {
    const path = novncRequestPath(req.url);
    // Node drops its own socket error handler on upgrade, so a client reset with no listener
    // crashes the server. Other upgrades belong to Vite's HMR or the API proxy, so only their
    // errors are ignored.
    if (!path) {
      socket.on("error", () => {});
      return;
    }
    req.url = path;
    const connectionId = randomUUID();
    const startedAt = Date.now();
    const bindings = {
      "screen.connection_id": connectionId,
      "screen.policy": screenPolicy(req.url),
    };
    let closeInitiator: "client" | "upstream" | "revoked" | undefined;
    // Listen before the access check; the close handler below tears down the upstream.
    socket.on("error", (error) => {
      screenLog.warn("screen.proxy.websocket_error", {
        ...bindings,
        "screen.side": "client",
        "error.code": socketErrorCode(error),
      });
      closeInitiator ??= "client";
    });
    const confirmedAt = performance.now();
    const target = await resolveNovncTarget(req.url, secret, api, (reason) => {
      screenLog.warn("screen.proxy.target_rejected", {
        ...bindings,
        "screen.transport": "websocket",
        reason,
      });
    });
    if (socket.destroyed) return;
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream =
      target.protocol === "https:"
        ? tls.connect({ port: target.port, host: target.hostname, servername: target.hostname })
        : net.connect(target.port, target.hostname);
    let upgraded = false;
    let closed = false;
    const logClose = (side: "client" | "upstream") => {
      if (closed) return;
      closed = true;
      const durationMs = Date.now() - startedAt;
      const details = {
        ...bindings,
        "screen.upgraded": upgraded,
        "screen.duration_ms": durationMs,
        "screen.closed_by": closeInitiator ?? side,
      };
      if (!upgraded || durationMs < 5_000) screenLog.warn("screen.proxy.websocket_closed", details);
      else screenLog.info("screen.proxy.websocket_closed", details);
    };
    const stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(req.url, secret, api, target),
      (reason) => {
        screenLog.warn("screen.proxy.websocket_revoked", {
          ...bindings,
          "screen.revoke_reason": reason,
        });
        closeInitiator ??= "revoked";
        socket.destroy();
        upstream.destroy();
      },
      {
        confirmedAt,
        expiresAt: screenCapabilityExpiry(req.url),
        onUnavailable: (consecutive) =>
          screenLog.warn("screen.proxy.recheck_unavailable", {
            ...bindings,
            "screen.transport": "websocket",
            "screen.consecutive": consecutive,
          }),
      },
    );
    socket.once("close", () => {
      logClose("client");
      stopChecking();
      upstream.destroy();
    });
    upstream.once("close", () => {
      logClose("upstream");
      stopChecking();
      socket.destroy();
    });
    upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      const headerLines = [
        `${req.method ?? "GET"} ${target.path} HTTP/1.1`,
        `Host: ${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
      ];
      for (const [key, value] of Object.entries(safeProxyHeaders(req.headers, target))) {
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
          screenLog.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "header_too_large",
          });
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
          screenLog.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "malformed_response",
          });
          socket.destroy();
          upstream.destroy();
          return;
        }
        const status = Number(
          responseHead
            .toString("latin1", 0, responseHead.indexOf("\r\n"))
            .match(/^HTTP\/1\.\d (\d{3})/)?.[1] ?? 0,
        );
        if (status !== 101) {
          screenLog.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "upstream_status",
            "http.status": status,
          });
        } else {
          upgraded = true;
          screenLog.info("screen.proxy.websocket_upgraded", {
            ...bindings,
            "screen.duration_ms": Date.now() - startedAt,
          });
        }
        upstream.off("data", forwardHandshake);
        socket.write(safe);
        upstream.pipe(socket);
      };
      upstream.on("data", forwardHandshake);
    });
    upstream.on("error", (error) => {
      screenLog.warn("screen.proxy.websocket_error", {
        ...bindings,
        "screen.side": "upstream",
        "error.code": socketErrorCode(error),
      });
      closeInitiator ??= "upstream";
      socket.destroy();
    });
  });
}

export default defineConfig(({ command, mode }) => {
  // Names this build in every API request; the dev server has none, so the handshake stays off.
  const buildId = command === "build" ? buildIdAt(new Date()) : "";
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const previewHost = process.env.RAKAZO_HOST ?? rootEnv.RAKAZO_HOST ?? "localhost";
  const allowedHosts = [
    previewHost,
    ...(process.env.RAKAZO_ALLOWED_HOSTS ?? rootEnv.RAKAZO_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  // Set by the server built from this config; reusing one config object for two servers would
  // leave the last one's list.
  let proxyHosts: readonly string[] | true = [];
  const proxy = apiProxy(api, () => proxyHosts);
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
  // Invalid origins throw here, so the server refuses to start rather than serve a wider policy.
  const appPolicy = appContentSecurityPolicy({
    scriptSrc: parseContentSecuritySources(
      "RAKAZO_CSP_SCRIPT_SRC",
      process.env.RAKAZO_CSP_SCRIPT_SRC ?? rootEnv.RAKAZO_CSP_SCRIPT_SRC,
    ),
    connectSrc: parseContentSecuritySources(
      "RAKAZO_CSP_CONNECT_SRC",
      process.env.RAKAZO_CSP_CONNECT_SRC ?? rootEnv.RAKAZO_CSP_CONNECT_SRC,
    ),
    crisp: parseCrispWebsiteId(process.env.CRISP_WEBSITE_ID ?? rootEnv.CRISP_WEBSITE_ID) !== null,
  });
  return {
    build: { sourcemap: true },
    define: { "import.meta.env.RAKAZO_BUILD": JSON.stringify(buildId) },
    plugins: [
      {
        // The API reads this to name the deployed build, and a tab fetches it to confirm the
        // server already serves a newer build before it reloads.
        name: "rakazo-build-id",
        apply: "build",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "build-id", source: `${buildId}\n` });
        },
      },
      react(),
      babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }),
      lingui(),
      tailwindcss(),
      rakazoPwa(buildId),
      {
        // Production only: the dev server injects inline scripts for React Refresh.
        name: "rakazo-content-security-policy",
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            const policy = contentSecurityPolicyFor(req.url?.split("?", 1)[0] ?? "/", appPolicy);
            if (policy) {
              res.setHeader("content-security-policy", policy);
              res.setHeader("reporting-endpoints", CSP_REPORTING_ENDPOINTS);
            }
            next();
          });
        },
      },
      {
        name: "rakazo-missing-asset-404",
        configurePreviewServer({ config, middlewares }) {
          const outDir = path.resolve(config.root, config.build.outDir);
          const assetsDir = path.join(outDir, config.build.assetsDir);
          let archive: string | null = null;
          try {
            archive = archiveAssets({
              assetsDir,
              archiveDir: path.resolve(config.root, ASSET_ARCHIVE_DIR),
              buildId: readFileSync(path.join(outDir, "build-id"), "utf8").trim(),
              now: Date.now(),
            });
          } catch (error) {
            screenLog.warn("web.asset_archive_failed", { "error.code": socketErrorCode(error) });
          }
          middlewares.use(
            missingAssetMiddleware(assetsDir, `${config.base}${config.build.assetsDir}/`, archive),
          );
        },
      },
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
        // The hosts the running server allows, as Vite resolved them, for proxied upgrades.
        name: "rakazo-api-proxy-hosts",
        configureServer: (server) => {
          proxyHosts = server.config.server.allowedHosts;
        },
        configurePreviewServer: (server) => {
          proxyHosts = server.config.preview.allowedHosts;
        },
      },
      {
        name: "rakazo-novnc-proxy",
        configureServer: (server) => attachNovncProxy(server, screenProxySecret(), api),
        configurePreviewServer: (server) => attachNovncProxy(server, screenProxySecret(), api),
      },
    ],
    server: {
      host: process.env.RAKAZO_DEV_HOST ?? rootEnv.RAKAZO_DEV_HOST ?? "127.0.0.1",
      port: webPort,
      strictPort: true,
      allowedHosts,
      proxy,
    },
    preview: {
      host: "0.0.0.0",
      port: Number(process.env.WEB_PORT ?? 5173),
      allowedHosts,
      proxy,
    },
  };
});
