import path from "node:path";
import {
  APP_CONTENT_SECURITY_POLICY,
  CSP_REPORTING_ENDPOINTS,
  HTML_VIEWER_PATH,
} from "@rakazo/contracts/content-security-policy";
import { describe, expect, it } from "vitest";
import {
  bundledRendererCandidates,
  bundledRendererHeaders,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";

const root = path.resolve("/tmp/rakazo-renderer");
const origin = "https://app.example.com";

describe("bundled desktop renderer", () => {
  it("serves static assets and falls back to index.html for app routes", () => {
    expect(bundledRendererCandidates(root, `${origin}/assets/app-123.js`, origin, false)).toEqual([
      path.join(root, "assets/app-123.js"),
    ]);
    expect(bundledRendererCandidates(root, `${origin}/app/bot-1`, origin, true)).toEqual([
      path.join(root, "app/bot-1"),
      path.join(root, "index.html"),
    ]);
    expect(bundledRendererCandidates(root, `${origin}/app/bot.name`, origin, true)).toEqual([
      path.join(root, "app/bot.name"),
      path.join(root, "index.html"),
    ]);
  });

  it("leaves APIs, screen proxying, and other origins on the network", () => {
    for (const pathname of ["/api/auth/session", "/rpc/bots", "/novnc/socket"]) {
      expect(bundledRendererCandidates(root, `${origin}${pathname}`, origin, false)).toBeNull();
    }
    expect(
      bundledRendererCandidates(root, "https://example.net/assets/app-123.js", origin, false),
    ).toBeNull();
  });

  it("does not resolve traversal outside the renderer root", () => {
    expect(
      bundledRendererCandidates(root, `${origin}/%2e%2e%2fsecret.txt`, origin, false),
    ).toBeNull();
    expect(bundledRendererCandidates(root, `${origin}/bad%00name.js`, origin, false)).toBeNull();
  });

  it("assigns cache and content metadata", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("app.woff2")).toBe("font/woff2");
    expect(immutableRendererAsset(path.join(root, "assets/app-123.js"))).toBe(true);
    expect(immutableRendererAsset(path.join(root, "index.html"))).toBe(false);
  });

  it("sends the web server's CSP with bundled documents", () => {
    const index = path.join(root, "index.html");
    const app = bundledRendererHeaders(index, `${origin}/bots/1?tab=chat`);
    expect(app.get("content-security-policy")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(app.get("reporting-endpoints")).toBe(CSP_REPORTING_ENDPOINTS);
    expect(app.get("x-content-type-options")).toBe("nosniff");
    expect(app.get("cache-control")).toBe("no-cache");
    const viewer = bundledRendererHeaders(
      path.join(root, "html-viewer.html"),
      `${origin}${HTML_VIEWER_PATH}`,
    );
    expect(viewer.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(
      bundledRendererHeaders(path.join(root, "assets/app-1.js"), `${origin}/assets/app-1.js`).get(
        "cache-control",
      ),
    ).toBe("public, max-age=31536000, immutable");
  });

  it("treats filesystem path misses as renderer fallbacks", () => {
    for (const code of ["ENOENT", "EISDIR", "ENOTDIR"]) {
      expect(isRendererAssetMiss(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isRendererAssetMiss(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isRendererAssetMiss(null)).toBe(false);
  });

  it("forwards cookies for both app and cross-origin requests", () => {
    const appOptions = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, { method: "POST", referrer: `${origin}/app` }),
      origin,
    );
    const oauthOptions = forwardedRendererRequestInit(
      new Request("https://oauth.example.com/authorize"),
      origin,
    );

    expect(appOptions.credentials).toBe("include");
    expect(new Headers(appOptions.headers).get("origin")).toBe(origin);
    expect(oauthOptions).toMatchObject({
      bypassCustomProtocolHandlers: true,
      credentials: "include",
    });
    expect(oauthOptions.headers).toBeUndefined();
  });

  it("vouches for the app origin only on requests from app pages", () => {
    const fromApp = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, { method: "POST", headers: { origin } }),
      origin,
    );
    const fromPopup = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, {
        method: "POST",
        headers: { origin: "https://oauth.example.com" },
        referrer: `${origin}/app`,
      }),
      origin,
    );
    const fromSandbox = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, { method: "POST", headers: { origin: "null" } }),
      origin,
    );
    const unattributed = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, { method: "POST" }),
      origin,
    );
    const fromForeignPage = forwardedRendererRequestInit(
      new Request(`${origin}/rpc/bots`, {
        method: "POST",
        referrer: "https://oauth.example.com/authorize",
      }),
      origin,
    );

    expect(new Headers(fromApp.headers).get("origin")).toBe(origin);
    for (const options of [fromPopup, fromSandbox, unattributed, fromForeignPage]) {
      expect(options.headers).toBeUndefined();
    }
  });
});
