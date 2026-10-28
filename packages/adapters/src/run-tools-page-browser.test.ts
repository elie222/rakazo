import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";

const secret = 'zq"xv\\mk';
const url = "https://example.test/echo";
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "u",
  signal: new AbortController().signal,
};

/** A page that echoes a secret of the run into the page title, a button's name and an input's value. */
async function runPageTool(name: string, args: Record<string, unknown> = {}) {
  const html = `<!doctype html><html><head><title>Echo ${secret}</title></head><body>
    <button aria-label='${secret}'>Echo</button><input aria-label="Field" value='${secret}' /></body></html>`;
  const browser = new FakeBrowserProvider({ pages: { [url]: { title: `Echo ${secret}`, html } } });
  await browser.navigate(computer, { url }, context);
  const ctx = {
    deps: { prisma: { taughtSkill: { findFirst: async () => null } } },
    run: { spaceId: "space", botId: "b1" },
    bot: { id: "b1" },
    context,
    computer: {
      heldForTakeover: false,
      graphicalToolsAllowed: false,
      mode: "private",
      checkpoint: { markDirty: () => {} },
      get: async () => computer,
    },
    tools: { disabled: new Set<string>() },
    providers: { browser },
    secrets: new Set([secret]),
    state: { screen: { unchangedVisualStreak: { count: 0 } } },
  };
  const call = { name, args, finish: async (result: unknown) => result };
  const result = (await pageBrowserTool(ctx as never, call as never)) as {
    content?: Array<{ text: string }>;
    details?: unknown;
  };
  // What the model reads, and the details kept beside it.
  return `${result.content?.map((part) => part.text).join("") ?? ""}${JSON.stringify(result.details ?? result)}`;
}

describe("page tools hide the run's secrets, also where a snapshot quotes them", () => {
  it.each(["browser_snapshot", "browser_navigate"])("%s", async (name) => {
    const seen = await runPageTool(name, { url });
    expect(seen).not.toContain("xv");
    expect(seen).toContain("[redacted]");
  });
});

describe("screen tools keep off the screen while a takeover holds it or teaching records it", () => {
  const teachingMessage = "Teaching is in progress. Stop teaching before using the computer.";
  const screenTools = [
    "open_path",
    "launch_app",
    "computer_observe",
    "computer_act",
    "browser_navigate",
  ];

  async function runScreenTool(name: string, held: boolean, teaching: boolean) {
    const act = vi.fn(async () => ({}));
    const observe = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => (teaching ? { id: "skill" } : null));
    const get = vi.fn(async () => computer);
    const ctx = {
      deps: {
        prisma: { taughtSkill: { findFirst } },
        sandbox: { act, observe },
        events: { append: async () => {} },
      },
      run: { spaceId: "space", botId: "b1" },
      bot: { id: "b1" },
      thread: { id: "t1" },
      context,
      computer: {
        heldForTakeover: held,
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get,
      },
      secrets: new Set<string>(),
    };
    const call = {
      name,
      args: { path: "https://example.test", application: "Firefox", url },
      finish: async (result: unknown) => result,
    };
    const handler = name === "browser_navigate" ? pageBrowserTool : computerTools[name];
    const result = await handler?.(ctx as never, call as never);
    return { result, act, observe, findFirst, get };
  }

  it.each(screenTools)("%s refuses while a takeover holds the screen", async (name) => {
    for (const teaching of [false, true]) {
      const run = await runScreenTool(name, true, teaching);
      expect(run.result).toEqual({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
      expect(run.findFirst).not.toHaveBeenCalled();
      expect(run.get).not.toHaveBeenCalled();
      expect(run.act).not.toHaveBeenCalled();
      expect(run.observe).not.toHaveBeenCalled();
    }
  });

  it.each(screenTools)("%s refuses while teaching records the screen", async (name) => {
    const run = await runScreenTool(name, false, true);
    expect(run.result).toEqual({ error: teachingMessage });
    expect(run.findFirst).toHaveBeenCalledWith({
      where: { spaceId: "space", botId: "b1", status: "recording" },
    });
    expect(run.get).not.toHaveBeenCalled();
    expect(run.act).not.toHaveBeenCalled();
    expect(run.observe).not.toHaveBeenCalled();
  });

  it.each(["open_path", "launch_app"])("%s acts when the screen is free", async (name) => {
    expect((await runScreenTool(name, false, false)).act).toHaveBeenCalledOnce();
  });
});
