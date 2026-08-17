import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledRendererCandidates,
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

  it("treats filesystem path misses as renderer fallbacks", () => {
    for (const code of ["ENOENT", "EISDIR", "ENOTDIR"]) {
      expect(isRendererAssetMiss(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isRendererAssetMiss(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isRendererAssetMiss(null)).toBe(false);
  });

  it("forwards cookies for both app and cross-origin requests", () => {
    const appOptions = forwardedRendererRequestInit(new Request(`${origin}/rpc/bots`), origin);
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
});
