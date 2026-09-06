import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProvider, resolveBrowserProviderKind } from "./browser-provider-factory.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";

const baseContext: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const pages = {
  "https://example.test/a": {
    title: "A",
    html: `<!doctype html><html><head><title>A</title></head><body>
      <input aria-label="Secret" value="from-bot-a" />
    </body></html>`,
  },
};

describe("browser provider factory", () => {
  const previous = process.env.BROWSER_PROVIDER;
  afterEach(() => {
    if (previous === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previous;
  });

  it("defaults production kind to computer, not fake", () => {
    delete process.env.BROWSER_PROVIDER;
    expect(resolveBrowserProviderKind({})).toBe("computer");
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "" })).toBe("computer");
    expect(createBrowserProvider().describe().id).toBe("computer");
    // API/worker pass undefined kind with a sandbox; still computer.
    expect(createBrowserProvider(undefined, {}).describe().id).toBe("computer");
  });

  it("selects fake or emulator only when BROWSER_PROVIDER asks for them", () => {
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "fake" })).toBe("fake");
    expect(createBrowserProvider("fake").describe().id).toBe("fake");
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "emulator" })).toBe("emulator");
    expect(createBrowserProvider("emulator").describe().id).toBe("emulator");
  });
});

describe("computer browser provider", () => {
  it("falls back to computer_act when live Chrome is unavailable", async () => {
    const provider = new ComputerBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "team-1",
      botId: "home-key",
      kind: "docker",
      providerRef: "team-1",
    };
    const result = await provider.navigate(
      computer,
      { url: "https://example.test/a" },
      { ...baseContext, botId: "bot-a" },
    );
    expect(result).toMatchObject({
      fallback: "computer_act",
      error: expect.stringMatching(/not attached|computer_act|live page browser/i),
    });
  });

  it("drives the live page path when the CDP helper succeeds", async () => {
    const liveDriver = vi.fn(async (_c, request, _ctx) => {
      const { command } = request;
      if (command === "navigate") {
        return { ok: true, url: String(request.url), title: "Live" };
      }
      if (command === "snapshot") {
        return {
          ok: true,
          url: "https://example.test/live",
          title: "Live",
          tree: '- textbox "Secret" [e1] value="live-secret"',
          elements: [{ ref: "e1", role: "textbox", name: "Secret", value: "live-secret" }],
        };
      }
      return {
        ok: true,
        completed: 1,
        url: "https://example.test/live",
        title: "Live",
        tree: '- textbox "Secret" [e1] value="typed"',
        elements: [{ ref: "e1", role: "textbox", name: "Secret", value: "typed" }],
      };
    });
    const provider = new ComputerBrowserProvider({ pages, liveDriver });
    const computer: ComputerRef = {
      id: "team-1",
      botId: "home-key",
      kind: "docker",
      providerRef: "team-1",
    };
    const context = { ...baseContext, botId: "bot-a" };
    const nav = await provider.navigate(computer, { url: "https://example.test/live" }, context);
    expect(nav).toEqual({ url: "https://example.test/live", title: "Live" });
    const snap = await provider.snapshot(computer, {}, context);
    expect(snap.fallback).toBeUndefined();
    expect(snap.elements[0]?.value).toBe("live-secret");
    const act = await provider.act(
      computer,
      { actions: [{ kind: "fill", ref: "e1", text: "typed" }] },
      context,
    );
    expect(act.ok).toBe(true);
    expect(act.completed).toBe(1);
    expect(liveDriver).toHaveBeenCalled();
    expect(liveDriver.mock.calls[0]?.[1]).toEqual({
      command: "navigate",
      url: "https://example.test/live",
    });
  });

  it("returns computer_act when the live driver reports failure", async () => {
    const provider = new ComputerBrowserProvider({
      pages,
      liveDriver: async () => ({
        ok: false,
        error: "chrome not listening",
        fallback: "computer_act",
      }),
    });
    const computer: ComputerRef = {
      id: "c1",
      botId: "home-key",
      kind: "docker",
      providerRef: "c1",
    };
    const result = await provider.snapshot(computer, {}, { ...baseContext, botId: "bot-a" });
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/chrome not listening/i);
  });

  it("uses in-process pages for fake computers", async () => {
    const provider = new ComputerBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "c1",
      botId: "bot-a",
      kind: "fake",
      providerRef: "c1",
    };
    const result = await provider.navigate(
      computer,
      { url: "https://example.test/a" },
      baseContext,
    );
    expect(result.fallback).toBeUndefined();
    expect(result.title).toBe("A");
  });
});

describe("page browser session isolation", () => {
  it("keeps page state when the same bot reacquires after a lease fence renewal", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const computer: ComputerRef = {
      id: "team-computer",
      botId: "team-home",
      kind: "fake",
      providerRef: "team-computer",
    };
    const first = { ...baseContext, botId: "bot-a", screenLeaseId: "run-1:1", runId: "run-1" };
    const resumed = { ...baseContext, botId: "bot-a", screenLeaseId: "run-1:8", runId: "run-1" };

    expect(pageBrowserSessionKey(computer, first)).toBe(pageBrowserSessionKey(computer, resumed));
    expect(pageBrowserSessionKey(computer, first)).toBe("team-computer::bot-a");

    await browser.navigate(computer, { url: "https://example.test/a" }, first);
    const snap = await browser.snapshot(computer, {}, resumed);
    expect(snap.url).toBe("https://example.test/a");
    expect(snap.elements.find((el) => el.name.includes("Secret"))?.value).toBe("from-bot-a");
  });

  it("keeps Team bots on the same computer in separate sessions", async () => {
    const browser = new FakeBrowserProvider({ pages });
    // Production Team computers share computer.botId (home key) across bots.
    const shared: ComputerRef = {
      id: "team-computer",
      botId: "team-home",
      kind: "fake",
      providerRef: "team-computer",
    };
    const contextA = { ...baseContext, botId: "bot-a" };
    const contextB = { ...baseContext, botId: "bot-b" };

    expect(pageBrowserSessionKey(shared, contextA)).not.toBe(
      pageBrowserSessionKey(shared, contextB),
    );

    await browser.navigate(shared, { url: "https://example.test/a" }, contextA);
    const snapA = await browser.snapshot(shared, {}, contextA);
    const secret = snapA.elements.find((el) => el.name.includes("Secret"));
    expect(secret?.value).toBe("from-bot-a");

    // Bot B has not navigated; its session must not see bot A's page.
    const snapB = await browser.snapshot(shared, {}, contextB);
    expect(snapB.url).toBe("about:blank");
    expect(snapB.elements.find((el) => el.name.includes("Secret"))).toBeUndefined();
  });
});

describe("page browser safety", () => {
  const computer: ComputerRef = {
    id: "computer",
    botId: "team-home",
    kind: "docker",
    providerRef: "computer",
  };

  it("does not advertise unavailable providers", () => {
    expect(new ComputerBrowserProvider().describe().capabilities.page).toBe(false);
  });

  it.each([{}, { ok: true }])(
    "rejects malformed live results instead of claiming success: %j",
    async (payload) => {
      const provider = new ComputerBrowserProvider({ liveDriver: async () => payload });
      expect(
        await provider.act(computer, { actions: [{ kind: "click", ref: "e1" }] }, baseContext),
      ).toMatchObject({ ok: false, uncertain: true, completed: 0 });
    },
  );

  it("preserves partial progress and uncertain outcomes", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: false, completed: 1, uncertain: true }),
    });
    expect(
      await provider.act(
        computer,
        {
          actions: [
            { kind: "click", ref: "e1" },
            { kind: "click", ref: "e2" },
          ],
        },
        baseContext,
      ),
    ).toMatchObject({ ok: false, uncertain: true, completed: 1 });
  });

  it("propagates cancellation instead of suggesting another action", async () => {
    const signal = AbortSignal.abort();
    const driver = vi.fn(async () => ({ ok: true }));
    const provider = new ComputerBrowserProvider({ liveDriver: driver });
    await expect(provider.snapshot(computer, {}, { ...baseContext, signal })).rejects.toThrow();
    expect(driver).not.toHaveBeenCalled();
  });
});
