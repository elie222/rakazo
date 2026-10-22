import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootComputerOnce,
  embeddableScreenUrl,
  isProxiedScreenUrl,
  loadComputerScreen,
  probeScreen,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
  screenIframeSandbox,
} from "./computer-screen";

describe("computer screen requests", () => {
  it("shows connection failures and lets a successful retry clear them", async () => {
    const commit = vi.fn();
    const options = {
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    };
    await loadComputerScreen({
      ...options,
      load: async () => {
        throw new Error("Control stream failed to start");
      },
    });
    expect(commit).toHaveBeenLastCalledWith({
      url: null,
      error: "Control stream failed to start",
    });

    await expect(
      loadComputerScreen({
        ...options,
        load: async () => ({ url: "https://screen.example/vnc.html" }),
      }),
    ).resolves.toBe("https://screen.example/vnc.html");
    expect(commit).toHaveBeenLastCalledWith({
      url: "https://screen.example/vnc.html",
      error: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const stale = loadComputerScreen({
        load: () => deferred,
        isCurrent: () => current === 1,
        commit,
        fallbackError: "Could not connect",
      });
      current = 2;
      await loadComputerScreen({
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
        commit,
        fallbackError: "Could not connect",
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith({
        url: null,
        error: "Latest connection failed",
      });
    },
  );

  it("uses the visible fallback for errors without a message", async () => {
    const commit = vi.fn();
    await loadComputerScreen({
      load: async () => Promise.reject(null),
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith({ url: null, error: "Could not connect" });
  });
});

describe("embeddableScreenUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides a local screen whose port does not match the page", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("http://127.0.0.1:6080/vnc.html")).toBeNull();
    expect(embeddableScreenUrl("http://localhost:6080/vnc.html")).toBeNull();
  });

  it("serves the screen proxy from the page origin", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/chat" } });
    expect(embeddableScreenUrl("http://127.0.0.1:5173/novnc/session/view/1.x/vnc.html?a=1")).toBe(
      "http://localhost:5173/novnc/session/view/1.x/vnc.html?a=1",
    );
  });

  it("keeps a non-local screen even when the port differs", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("https://screen.example:6080/vnc.html")).toBe(
      "https://screen.example:6080/vnc.html",
    );
  });
});

describe("screenIframeSandbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows scripts and pointer lock only for /novnc/ paths", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(screenIframeSandbox("http://127.0.0.1:5173/novnc/vnc.html")).toBe(
      "allow-scripts allow-pointer-lock",
    );
    expect(screenIframeSandbox("http://127.0.0.1:5173/vnc.html")).toBeUndefined();
  });
});

function pendingBoot() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("computer boot ownership", () => {
  it("starts B independently and refuses a second A after switching A to B to A", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const b = pendingBoot();
    const duplicate = vi.fn();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const second = bootComputerOnce(inFlight, "b", () => b.promise);
    await bootComputerOnce(inFlight, "a", duplicate);
    expect(duplicate).not.toHaveBeenCalled();
    b.resolve();
    await second;
    expect(inFlight.has("a")).toBe(true);
    a.resolve();
    await first;
    await bootComputerOnce(inFlight, "a", duplicate);
    expect(duplicate).toHaveBeenCalledOnce();
    expect(inFlight.size).toBe(0);
  });

  it("lets takeover proceed while a boot request is in flight", async () => {
    const inFlight = new Map<string, symbol>();
    const boot = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => boot.promise);
    const duplicateBoot = vi.fn();
    const takeover = vi.fn();
    await bootComputerOnce(inFlight, "a", duplicateBoot);
    await takeover();
    expect(duplicateBoot).not.toHaveBeenCalled();
    expect(takeover).toHaveBeenCalledOnce();
    expect(inFlight.has("a")).toBe(true);
    boot.resolve();
    await first;
  });

  it("allows a retry after failure", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const rejected = expect(first).rejects.toThrow("Boot failed");
    a.reject(new Error("Boot failed"));
    await rejected;
    const retry = vi.fn();
    await bootComputerOnce(inFlight, "a", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not release a replacement owner's marker when an older request finishes", async () => {
    const inFlight = new Map<string, symbol>();
    const a = pendingBoot();
    const first = bootComputerOnce(inFlight, "a", () => a.promise);
    const replacement = Symbol("replacement");
    inFlight.set("a", replacement);
    a.resolve();
    await first;
    expect(inFlight.get("a")).toBe(replacement);
  });
});

describe("screen frame reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only known states and bounds the detail", () => {
    expect(screenFrameMessage({ rakazoScreen: "connected" })).toEqual({
      rakazoScreen: "connected",
    });
    expect(screenFrameMessage({ rakazoScreen: "failed", detail: "  Failed to connect  " })).toEqual(
      { rakazoScreen: "failed", detail: "Failed to connect" },
    );
    expect(
      screenFrameMessage({ rakazoScreen: "failed", detail: "x".repeat(300) })?.detail,
    ).toHaveLength(200);
    expect(screenFrameMessage({ rakazoScreen: "failed", detail: 5 })).toEqual({
      rakazoScreen: "failed",
    });
    expect(screenFrameMessage({ rakazoScreen: "exploded" })).toBeNull();
    expect(screenFrameMessage("connected")).toBeNull();
    expect(screenFrameMessage(null)).toBeNull();
  });

  it("counts only reports past loading as a started page", () => {
    expect(screenFrameStarted({ rakazoScreen: "loading" })).toBe(false);
    expect(screenFrameStarted({ rakazoScreen: "connecting" })).toBe(true);
    expect(screenFrameStarted({ rakazoScreen: "connected" })).toBe(true);
    expect(screenFrameStarted({ rakazoScreen: "failed" })).toBe(true);
  });

  it("turns failures into the error to show and keeps progress silent", () => {
    expect(screenFrameError({ rakazoScreen: "loading" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "connecting" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "connected" }, "fallback")).toBeNull();
    expect(screenFrameError({ rakazoScreen: "failed", detail: "Refused" }, "fallback")).toBe(
      "Refused",
    );
    expect(screenFrameError({ rakazoScreen: "failed" }, "fallback")).toBe("fallback");
    expect(screenFrameError({ rakazoScreen: "disconnected" }, "fallback")).toBe("fallback");
  });

  it("only treats the proxy's own pages as reporting frames", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(isProxiedScreenUrl("http://127.0.0.1:5173/novnc/session/view/1.t/vnc.html")).toBe(true);
    expect(isProxiedScreenUrl("https://screen.example/vnc.html")).toBe(false);
    expect(isProxiedScreenUrl(null)).toBe(false);
  });
});

describe("probeScreen", () => {
  const url = "http://127.0.0.1:5173/novnc/session/view/1.t/vnc.html";
  const response = (status: number, body = "", type = "basic") =>
    ({ ok: status >= 200 && status < 300, status, type, text: async () => body }) as Response;

  it("is silent for a page the proxy serves", async () => {
    const fetchImpl = vi.fn(async () => response(200, "<html>"));
    await expect(probeScreen(url, "fallback", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
  });

  it("reports the proxy's reason for a refused or failed page", async () => {
    await expect(
      probeScreen(url, "fallback", async () =>
        response(403, "Invalid or expired screen capability"),
      ),
    ).resolves.toBe("Invalid or expired screen capability");
    await expect(
      probeScreen(url, "fallback", async () =>
        response(502, "Screen unavailable (upstream_timeout)"),
      ),
    ).resolves.toBe("Screen unavailable (upstream_timeout)");
    await expect(probeScreen(url, "fallback", async () => response(503))).resolves.toBe(
      "fallback (HTTP 503)",
    );
  });

  it("never shows an upstream HTML error page as the reason", async () => {
    await expect(
      probeScreen(url, "fallback", async () =>
        response(502, "<!DOCTYPE html><html><body><h1>Bad gateway</h1></body></html>"),
      ),
    ).resolves.toBe("fallback (HTTP 502)");
    const html = {
      ...response(500, "Bad gateway"),
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    } as Response;
    await expect(probeScreen(url, "fallback", async () => html)).resolves.toBe(
      "fallback (HTTP 500)",
    );
  });

  it("falls back when the page cannot be fetched or would leave the app", async () => {
    await expect(
      probeScreen(url, "fallback", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).resolves.toBe("fallback");
    await expect(
      probeScreen(url, "fallback", async () => response(0, "", "opaqueredirect")),
    ).resolves.toBe("fallback");
  });
});
