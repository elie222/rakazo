import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootComputerOnce,
  embeddableScreenUrl,
  loadComputerScreen,
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
