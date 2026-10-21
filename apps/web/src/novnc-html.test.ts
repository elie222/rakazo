import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectNovncHtml,
  injectNovncStorageShim,
  isNovncPage,
  MAX_NOVNC_HTML_BYTES,
  novncPageRequestHeaders,
  rewrittenNovncHeaders,
  shouldInjectNovncStorageShim,
} from "./novnc-html.js";

const html = { "content-type": "text/html; charset=utf-8" };

describe("noVNC storage shim gate", () => {
  it("matches noVNC pages on any provider path", () => {
    expect(isNovncPage("/vnc.html")).toBe(true);
    expect(isNovncPage("/vnc_lite.html?autoconnect=true")).toBe(true);
    expect(isNovncPage("/proxy/6080/embed.html")).toBe(true);
    expect(isNovncPage("/core/rfb.js")).toBe(false);
    expect(isNovncPage("/index.html")).toBe(false);
    expect(isNovncPage("/websockify")).toBe(false);
  });

  it("injects into noVNC HTML", () => {
    expect(shouldInjectNovncStorageShim(html, "/vnc.html")).toBe(true);
    expect(
      shouldInjectNovncStorageShim({ "content-type": "application/xhtml+xml" }, "/vnc.html"),
    ).toBe(true);
  });

  it("skips non-HTML responses", () => {
    expect(shouldInjectNovncStorageShim({ "content-type": "text/javascript" }, "/vnc.html")).toBe(
      false,
    );
    expect(shouldInjectNovncStorageShim({}, "/vnc.html")).toBe(false);
  });

  it("skips HTML that is not a noVNC page", () => {
    expect(shouldInjectNovncStorageShim(html, "/index.html")).toBe(false);
  });

  it("injects into HTML marked identity encoded", () => {
    expect(
      shouldInjectNovncStorageShim({ ...html, "content-encoding": "identity" }, "/vnc.html"),
    ).toBe(true);
  });

  it("skips compressed HTML it cannot rewrite", () => {
    expect(shouldInjectNovncStorageShim({ ...html, "content-encoding": "gzip" }, "/vnc.html")).toBe(
      false,
    );
  });

  it("puts the shim before the first script", () => {
    const headed = injectNovncStorageShim("<html><head><title>x</title>");
    expect(headed).toMatch(/^<html><head><script>/);
    expect(headed.indexOf("localStorage")).toBeLessThan(headed.indexOf("<title>"));
    const bare = injectNovncStorageShim('<!doctype html><script src="app.js"></script>');
    expect(bare.indexOf("localStorage")).toBeLessThan(bare.indexOf('src="app.js"'));
  });

  function runShim() {
    const script = injectNovncStorageShim("<head>").match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    const listeners: ((event: unknown) => void)[] = [];
    const window = {
      addEventListener: (_type: string, listener: (event: unknown) => void) => {
        listeners.push(listener);
      },
    } as unknown as { localStorage: Storage; sessionStorage: Storage };
    new Function("window", script)(window);
    return { window, listeners };
  }

  it("keeps values for the life of the page in both storages", () => {
    const { window } = runShim();
    for (const storage of [window.localStorage, window.sessionStorage]) {
      storage.setItem("setting", "value");
      expect(storage.getItem("setting")).toBe("value");
      storage.removeItem("setting");
      expect(storage.getItem("setting")).toBeNull();
      storage.setItem("other", 1 as unknown as string);
      storage.clear();
      expect(storage.getItem("other")).toBeNull();
    }
    window.localStorage.setItem("only", "local");
    expect(window.sessionStorage.getItem("only")).toBeNull();
  });

  it("keeps extension script errors away from noVNC's error page", () => {
    const { listeners } = runShim();
    expect(listeners).toHaveLength(1);
    const stopped = (filename: string) => {
      let stop = false;
      listeners[0]?.({ filename, stopImmediatePropagation: () => (stop = true) });
      return stop;
    };
    expect(stopped("chrome-extension://abc/content.js")).toBe(true);
    expect(stopped("moz-extension://abc/content.js")).toBe(true);
    expect(stopped("https://screen.example/core/rfb.js")).toBe(false);
    expect(stopped("")).toBe(false);
  });
});

describe("noVNC page caching", () => {
  it("drops validators so the upstream sends the full page", () => {
    expect(
      novncPageRequestHeaders({
        accept: "text/html",
        "accept-encoding": "gzip, br",
        "if-modified-since": "Wed, 21 Oct 2026 01:05:20 GMT",
        "if-none-match": '"abc"',
      }),
    ).toEqual({ accept: "text/html", "accept-encoding": "identity" });
  });

  it("marks the rewritten page as never stored", () => {
    expect(
      rewrittenNovncHeaders({
        ...html,
        "content-length": "10",
        etag: '"abc"',
        "last-modified": "Wed, 21 Oct 2026 01:05:20 GMT",
        expires: "Thu, 22 Oct 2026 01:05:20 GMT",
        "cache-control": "max-age=3600",
      }),
    ).toEqual({ ...html, "cache-control": "no-store" });
  });
});

describe("noVNC HTML read", () => {
  it("returns a document that ends", async () => {
    const html = await collectNovncHtml(Readable.from([Buffer.from("<html></html>")]), 1024);
    expect(html).toBe("<html></html>");
  });

  it("rejects a document over the size cap", async () => {
    const stream = Readable.from([Buffer.alloc(MAX_NOVNC_HTML_BYTES + 1)]);
    await expect(collectNovncHtml(stream, MAX_NOVNC_HTML_BYTES)).rejects.toThrow(/exceeds/);
  });

  it("rejects an upstream abort that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("aborted");
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("rejects an upstream close that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("close");
    await expect(pending).rejects.toThrow(/closed/);
  });
});
