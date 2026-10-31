import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { encodeRunCode } from "./bot-secrets.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { EncryptedSecretStore } from "./secrets.js";
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

describe("browser_act fill_code", () => {
  const code = "482913";
  const origin = "https://login.example.test";
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  /** A run holding a code its user entered for the page, and a page with a field for it. */
  async function runWithCode(held: { origin: string } | null = { origin }) {
    const browser = new FakeBrowserProvider({
      pages: {
        [`${origin}/verify`]: {
          title: "Verify",
          html: `<!doctype html><html><head><title>Verify</title></head><body>
            <input aria-label="Code" /></body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: `${origin}/verify` }, context);
    const rows: Array<Record<string, unknown>> = [];
    if (held) {
      const stored = await secretStore.put(
        encodeRunCode(held.origin, code),
        {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "space",
          userId: "u",
          signal: context.signal,
        },
        { ephemeral: true },
      );
      rows.push({ ...stored, userId: "u", spaceId: "space", kind: "run-code:run-1" });
    }
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst: async () => null },
          secret: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
              rows.find((row) => matches(row, where)) ?? null,
            updateMany: async ({
              where,
              data,
            }: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              const found = rows.filter((row) => matches(row, where));
              for (const row of found) Object.assign(row, data);
              return { count: found.length };
            },
          },
        },
        secretStore,
      },
      run: { id: "run-1", spaceId: "space", userId: "u", botId: "b1" },
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
      secrets: [] as string[],
      state: {
        screen: { unchangedVisualStreak: { count: 0 } },
        reply: {
          pendingProgress: "",
          redactor: { finish: () => "" },
        },
      },
    };
    const fill = async () => {
      const snapshot = (await browser.snapshot(computer, {}, context)) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = snapshot.elements.find((element) => element.name === "Code")!.ref;
      const call = {
        name: "browser_act",
        args: { actions: [{ kind: "fill_code", ref }] },
        finish: async (result: unknown) => result,
      };
      const result = (await pageBrowserTool(ctx as never, call as never)) as {
        content?: Array<{ text: string }>;
        details?: unknown;
      };
      return `${result.content?.map((part) => part.text).join("") ?? ""}${JSON.stringify(result.details ?? result)}`;
    };
    return { ctx, rows, fill };
  }

  it("types the code once, never shows it to the bot, and has none left to type again", async () => {
    const { ctx, rows, fill } = await runWithCode();
    const first = await fill();
    expect(first).toContain('"ok":true');
    expect(first).not.toContain(code);
    expect(ctx.secrets).toContain(code);
    // The page took it: it stays only to be hidden, and is never typed again.
    expect(rows).toMatchObject([{ kind: "run-code-spent:run-1" }]);
    const second = await fill();
    expect(second).toContain("No code is waiting");
    expect(second).not.toContain(code);
  });

  it("refuses when the run has no code, and touches nothing", async () => {
    const { fill } = await runWithCode(null);
    expect(await fill()).toContain("No code is waiting");
  });

  it("refuses a code kept for plain HTTP, and keeps it", async () => {
    const { rows, fill } = await runWithCode({ origin: "http://login.example.test" });
    const result = await fill();
    expect(result).toContain("isn't HTTPS");
    expect(result).not.toContain(code);
    expect(rows).toHaveLength(1);
  });
});
