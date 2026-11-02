import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
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

describe("page tools save a page's file downloads in the calling bot's own folder", () => {
  // A saved name never has a backslash: the helper turns one into an underscore.
  const nameSecret = 'zq"xv-mk';

  async function download(name: string, mode: "team" | "dedicated", botId: string, saved = true) {
    const requests: PageBrowserCommand[] = [];
    const browser = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        requests.push(request);
        const folder = "downloads" in request ? request.downloads : undefined;
        return {
          ok: true,
          completed: 1,
          url: "https://bank.example/statements",
          title: "Statements",
          tree: '- link "Statement" [e1]',
          elements: [{ ref: "e1", role: "link", name: "Statement" }],
          ...(saved
            ? {
                downloads: [
                  {
                    name: `statement ${nameSecret}.pdf`,
                    path: `${folder}/statement ${nameSecret}.pdf`,
                    size: 4,
                    type: "application/pdf",
                  },
                ],
              }
            : {}),
        };
      },
    });
    const ctx = {
      deps: { prisma: { taughtSkill: { findFirst: async () => null } } },
      run: { spaceId: "space", botId },
      bot: { id: botId },
      context,
      computer: {
        heldForTakeover: false,
        graphicalToolsAllowed: false,
        mode,
        checkpoint: { markDirty: () => {} },
        get: async () => ({ ...computer, kind: "docker" }),
      },
      tools: { disabled: new Set<string>() },
      providers: { browser },
      secrets: new Set([nameSecret]),
      state: { screen: { unchangedVisualStreak: { count: 0 } } },
    };
    const args =
      name === "browser_navigate"
        ? { url: "https://bank.example/files/statement.pdf" }
        : { actions: [{ kind: "click", ref: "e1" }] };
    const call = { name, args, finish: async (result: unknown) => result };
    const result = (await pageBrowserTool(ctx as never, call as never)) as {
      content?: Array<{ text: string }>;
      details?: unknown;
    };
    const text = result.content?.map((part) => part.text).join("") ?? JSON.stringify(result);
    return { requests, text, details: JSON.stringify(result.details ?? result) };
  }

  it.each(["browser_act", "browser_navigate"])("%s", async (name) => {
    for (const [mode, botId, folder] of [
      ["team", "b1", "bots/b1/Downloads"],
      ["team", "b2", "bots/b2/Downloads"],
      ["dedicated", "b1", "Downloads"],
    ] as const) {
      const { requests, text, details } = await download(name, mode, botId);
      expect(requests).toEqual([expect.objectContaining({ downloads: folder })]);
      // The path the bot reads is the one its shell and file tools take, and leads back to the file.
      const path = "Downloads/statement [redacted].pdf";
      expect(JSON.parse(text).downloads).toEqual([
        { name: "statement [redacted].pdf", path, size: 4, type: "application/pdf" },
      ]);
      expect(resolveBotWorkspacePath(mode, botId, path)).toBe(`${folder}/statement [redacted].pdf`);
      expect(`${text}${details}`).not.toContain("xv");
    }
  });

  it.each(["browser_act", "browser_navigate"])(
    "%s result from a helper that saved nothing is unchanged",
    async (name) => {
      const { text } = await download(name, "team", "b1", false);
      expect(JSON.parse(text)).not.toHaveProperty("downloads");
    },
  );
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
