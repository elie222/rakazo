import { describe, expect, it, vi } from "vitest";
import {
  MAX_OUTSIDE_TEXT_CHARS,
  outsideOnlyTargets,
} from "../../approvals/review-target-sources.js";
import { readItems } from "../../routines/routine-watch.js";
import { clipToolResultText } from "../../runtime/pi/pi-runtime-limits.js";
import { serializeToolResult } from "../../runtime/pi/tools/pi-runtime-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { taskTools } from "./run-tools-tasks.js";

type Row = {
  id: string;
  name: string;
  threadId: string | null;
  spaceId: string;
  botId: string;
  userId?: string;
};

/**
 * The bot's routines in its own chat, the group and none (made on the web), plus another member's
 * in the group, filtered like the database would.
 */
function groupRun() {
  const rows: Row[] = [
    { id: "routine-dm", name: "Daily check", threadId: "dm-thread", spaceId: "s", botId: "b" },
    { id: "routine-group", name: "Digest", threadId: "group-thread", spaceId: "s", botId: "b" },
    { id: "routine-web", name: "Weekly", threadId: null, spaceId: "s", botId: "b" },
    {
      id: "routine-peer",
      name: "Peer",
      threadId: "group-thread",
      spaceId: "s",
      botId: "other",
      userId: "u",
    },
    {
      id: "routine-colleague",
      name: "Colleague's",
      threadId: "other-thread",
      spaceId: "s",
      botId: "other",
      userId: "colleague",
    },
  ];
  const matches = (where: Record<string, unknown>) =>
    rows.filter((row) =>
      (["id", "name", "threadId", "spaceId", "botId"] as const).every(
        (key) => where[key] === undefined || where[key] === row[key],
      ),
    );
  const saved = (row: Row) => ({
    ...row,
    prompt: "p",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    inChat: false,
    nextRunAt: new Date("2100-01-01T09:00:00Z"),
    watch: null,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
  });
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    matches(where).map(saved),
  );
  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const row = matches(where)[0];
    return row ? saved(row) : null;
  });
  const count = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) => matches(where).length,
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const bots = [
    { id: "other", name: "Other", thread: { id: "other-thread" } },
    { id: "b", name: "Bot", thread: { id: "dm-thread" } },
  ];
  const findBots = vi.fn(
    async ({ where }: { where: { spaceId: string; id?: string; name?: string } }) =>
      bots.filter(
        (row) =>
          where.spaceId === "s" &&
          (where.id === undefined || where.id === row.id) &&
          (where.name === undefined || where.name === row.name),
      ),
  );
  const ctx = {
    deps: {
      prisma: {
        routine: { count, findMany, findFirst, deleteMany, updateMany },
        bot: { findMany: findBots },
        scratchpadItem: { findMany: vi.fn(async () => []) },
        taughtSkill: { findMany: vi.fn(async () => []) },
        agentSkill: { findMany: vi.fn(async () => []) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    },
    fleetRun: { spaceId: "s", userId: "u", botId: "b" },
    run: { id: "run-1", spaceId: "s", userId: "u", threadId: "group-thread" },
    bot: { id: "b", name: "Bot" },
    thread: { id: "group-thread", groupId: "group-1" },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, deleteMany, updateMany };
}

describe("routine tools in a group run", () => {
  it("lists the bot's routines from every chat and marks the group's own", async () => {
    const { ctx, call } = groupRun();
    const marks = [
      ["routine-dm", false],
      ["routine-group", true],
      ["routine-web", false],
    ];
    const note =
      "inThisChat marks the routines this group chat can change; change the others from the bot's own chat.";
    const listed = (await taskTools.schedule_list!(ctx, call("schedule_list"))) as {
      note: string;
      routines: { routineId: string; inThisChat: boolean }[];
    };
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(listed.note).toBe(note);
    const catalog = (await taskTools.task_catalog!(ctx, call("task_catalog"))) as {
      routinesNote: string;
      routines: typeof listed.routines;
    };
    expect(catalog.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(catalog.routinesNote).toBe(note);
  });

  it("refuses to change a listed routine from another chat, saying where it is", async () => {
    const { ctx, call, deleteMany } = groupRun();
    const error = {
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    };
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { routineId: "routine-dm", name: "x" }),
      ),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { name: "Daily check" })),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId: "routine-web" })),
    ).resolves.toEqual(error);
    for (const routineId of ["made-up", "routine-peer"]) {
      await expect(
        taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId })),
      ).resolves.toEqual({ error: "Schedule not found." });
      await expect(
        taskTools.schedule_update!(ctx, call("schedule_update", { routineId, name: "x" })),
      ).resolves.toEqual({ error: "Schedule not found." });
    }
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("routine tools on a bot this bot manages", () => {
  it("lists all of that bot's routines, wherever they post", async () => {
    const { ctx, call } = groupRun();
    const listed = (await taskTools.schedule_list!(
      ctx,
      call("schedule_list", { bot_name: "Other" }),
    )) as { note?: string; routines: { routineId: string; inThisChat?: boolean }[] };
    expect(listed.note).toBeUndefined();
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual([
      ["routine-peer", undefined],
      ["routine-colleague", undefined],
    ]);
  });

  it("changes and cancels its routines, but only its owner changes what one does", async () => {
    const { ctx, call, deleteMany, updateMany } = groupRun();
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { bot_id: "other", routineId: "routine-peer", prompt: "New" }),
      ),
    ).resolves.toMatchObject({ ok: true, routineId: "routine-peer" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "s", botId: "other", id: "routine-peer" }),
        data: { prompt: "New" },
      }),
    );
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { bot_id: "other", routineId: "routine-colleague", prompt: "x" }),
      ),
    ).resolves.toEqual({
      error:
        "Only the person who owns this routine can change it. You can still pause or resume it with active, or make the user their own copy with schedule_create.",
    });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "other", name: "Colleague's" }),
      ),
    ).resolves.toEqual({ ok: true, routineId: "routine-colleague", name: "Colleague's" });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { spaceId: "s", botId: "other", id: "routine-colleague" },
    });
  });

  it("finds no bot outside the space, and naming itself keeps a group run to the group", async () => {
    const { ctx, call, deleteMany } = groupRun();
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "elsewhere", routineId: "routine-peer" }),
      ),
    ).resolves.toEqual({ error: 'No bot with id "elsewhere". Call list_fleet for ids.' });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "other", routineId: "routine-dm" }),
      ),
    ).resolves.toEqual({ error: "Schedule not found." });
    await expect(
      taskTools.schedule_cancel!(
        ctx,
        call("schedule_cancel", { bot_id: "b", routineId: "routine-dm" }),
      ),
    ).resolves.toEqual({
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("routine read watch-check taint and effect completion", () => {
  function watchReadRun(watchState: unknown) {
    const routineRow = {
      id: "routine-watch",
      name: "Inbox watch",
      prompt: "Check alerts",
      crons: [],
      timezone: "UTC",
      inChat: false,
      active: true,
      nextRunAt: null,
      watch: { kind: "http", url: "https://status.example.test", everyMinutes: 15 },
      watchState,
      eventTriggers: null,
      threadId: "dm-thread",
      spaceId: "s",
      botId: "b",
      userId: "u",
    };
    const ctx = {
      deps: {
        prisma: {
          routine: { findMany: vi.fn(async () => [routineRow]) },
          scratchpadItem: { findMany: vi.fn(async () => []) },
          taughtSkill: { findMany: vi.fn(async () => []) },
          agentSkill: { findMany: vi.fn(async () => []) },
          bot: { findMany: vi.fn(async () => []) },
        },
      },
      run: { id: "run-1", spaceId: "s", userId: "u", threadId: "dm-thread" },
      bot: { id: "b", name: "Bot" },
      fleetRun: { spaceId: "s", botId: "b", userId: "u" },
      thread: { id: "dm-thread", groupId: null },
      tools: { offered: [] },
      state: { tainted: false, taintedBeyondOwnComputer: false, outsideText: "" },
    } as unknown as RunContext;
    const finish = vi.fn(async (result: unknown) => result);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      ({ name, args, finish }) as unknown as ToolCall;
    return { ctx, call, finish };
  }

  const structuredWatchState = {
    checkedAt: "2026-11-25T07:00:00.000Z",
    outcome: "changed",
    fingerprint: "fp-1",
    entries: {
      "alice@example.com": 'rakazo:item:{"fields":["open"],"title":"Invoice"}',
    },
    detail: "1 new item",
  };

  it.each(["schedule_list", "task_catalog"] as const)(
    "%s taints the run and records structured watch entry keys and values, and finishes its effect",
    async (toolName) => {
      const { ctx, call, finish } = watchReadRun(structuredWatchState);
      const result = await taskTools[toolName]!(ctx, call(toolName));
      expect(finish).toHaveBeenCalledWith(result);
      expect(ctx.state.tainted).toBe(true);
      expect(ctx.state.taintedBeyondOwnComputer).toBe(true);
      expect(ctx.state.outsideText).toContain("alice@example.com");
      expect(ctx.state.outsideText).toContain("invoice");
    },
  );

  it.each(["schedule_list", "task_catalog"] as const)(
    "%s leaves the run untainted when watch lastCheck is null, and still finishes its effect",
    async (toolName) => {
      const { ctx, call, finish } = watchReadRun(null);
      const result = await taskTools[toolName]!(ctx, call(toolName));
      expect(finish).toHaveBeenCalledWith(result);
      expect(ctx.state.tainted).toBe(false);
      expect(ctx.state.taintedBeyondOwnComputer).toBe(false);
    },
  );

  it("finishes schedule_list effect when resolving a managed bot target fails", async () => {
    const { ctx, call, finish } = watchReadRun(null);
    const result = await taskTools.schedule_list!(
      ctx,
      call("schedule_list", { bot_id: "missing-bot" }),
    );
    expect(result).toEqual({ error: 'No bot with id "missing-bot". Call list_fleet for ids.' });
    expect(finish).toHaveBeenCalledWith(result);
  });

  it("transitions an approved schedule_list effect through the real gate from executing to completed", async () => {
    const effectRow: {
      id: string;
      runId: string;
      spaceId: string;
      kind: string;
      idempotencyKey: string;
      status: string;
      request: unknown;
      result: unknown;
    } = {
      id: "effect-1",
      runId: "run-1",
      spaceId: "s",
      kind: "schedule_list",
      idempotencyKey: "run-1:schedule_list:approved",
      status: "approved",
      request: { bot_id: "other", bot_name: "Other" },
      result: null,
    };
    const ctx = {
      deps: {
        prisma: {
          externalEffect: {
            findUnique: vi.fn(
              async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
                where.id === effectRow.id || where.idempotencyKey === effectRow.idempotencyKey
                  ? { ...effectRow }
                  : null,
            ),
            updateMany: vi.fn(
              async ({
                where,
                data,
              }: {
                where: { id: string; status: string };
                data: { status: string; result?: unknown };
              }) => {
                if (where.id !== effectRow.id || where.status !== effectRow.status) {
                  return { count: 0 };
                }
                effectRow.status = data.status;
                if (data.result !== undefined) effectRow.result = data.result;
                return { count: 1 };
              },
            ),
          },
          bot: {
            findMany: vi.fn(async () => [{ id: "other", name: "Other", spaceId: "s" }]),
          },
          routine: {
            findMany: vi.fn(async () => [
              {
                id: "routine-watch",
                name: "Inbox watch",
                prompt: "Check alerts",
                crons: [],
                timezone: "UTC",
                inChat: false,
                active: true,
                nextRunAt: null,
                watch: { kind: "tool", tool: "list_messages", track: ["from", "status"] },
                watchState: structuredWatchState,
                eventTriggers: null,
                threadId: "other-dm",
                spaceId: "s",
                botId: "other",
                userId: "u",
              },
            ]),
          },
        },
        events: { append: vi.fn(async () => {}) },
      },
      run: {
        id: "run-1",
        spaceId: "s",
        userId: "u",
        threadId: "dm-thread",
        botId: "b",
        trigger: "webhook",
      },
      runId: "run-1",
      bot: { id: "b", name: "Bot" },
      fleetRun: { spaceId: "s", botId: "b", userId: "u" },
      thread: { id: "dm-thread", groupId: null },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: false },
      tools: { connector: new Map(), connectedPlugins: [], offered: [] },
      state: {
        tainted: false,
        taintedBeyondOwnComputer: false,
        outsideText: "",
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
      },
    } as unknown as RunContext;
    const args = { bot_id: "other", bot_name: "Other" };
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const request = {
      name: "schedule_list",
      args,
      executionId,
      connectorCall: { tool: "schedule_list", args, executionId, route: undefined },
      effectRequest: args,
      resolvedTool: undefined,
      catalogRemapped: false,
      nextApprovedTool: "schedule_list",
      approvedEffectKey: effectRow.idempotencyKey,
      replayEffectToolName: "schedule_list",
      fleetSummary: undefined,
      heldForApproval: true,
      settingsChange: false,
      ignoresAllowRules: true,
      purchase: undefined,
      cardUse: undefined,
      loginUse: undefined,
    } as unknown as ToolRequest;

    const gated = await gateToolCall(ctx, request, undefined);
    expect("call" in gated).toBe(true);
    expect(effectRow.status).toBe("executing");
    if (!("call" in gated)) return;

    const result = await taskTools.schedule_list!(ctx, gated.call);
    expect(effectRow.status).toBe("completed");
    expect(effectRow.result).toEqual(result);
    expect(ctx.state.tainted).toBe(true);
    expect(ctx.state.taintedBeyondOwnComputer).toBe(true);
    expect(ctx.state.outsideText).toContain("alice@example.com");
    expect(ctx.state.outsideText).toContain("invoice");
  });

  it("preserves short middle entries, head, tail, and entry keys when a watch snapshot exceeds MAX_OUTSIDE_TEXT_CHARS", async () => {
    const pad = Math.floor(MAX_OUTSIDE_TEXT_CHARS * 0.65);
    const { ctx, call } = watchReadRun({
      checkedAt: "2026-11-25T07:00:00.000Z",
      outcome: "changed",
      fingerprint: "fp-huge",
      detail: "Notify dave@example.com",
      entries: {
        "early@example.com": `rakazo:item:${"x".repeat(pad)}`,
        "mid-key@example.com": "rakazo:item:forward to middle@example.com",
        "late@example.com": `rakazo:item:${"y".repeat(pad)} cc erin@example.com`,
      },
    });
    await taskTools.schedule_list!(ctx, call("schedule_list"));
    expect(
      outsideOnlyTargets(
        {
          to: [
            "dave@example.com",
            "early@example.com",
            "middle@example.com",
            "mid-key@example.com",
            "erin@example.com",
            "late@example.com",
          ],
        },
        { ownerWords: ["List schedules"], outsideText: ctx.state.outsideText },
      ),
    ).toEqual([
      "dave@example.com",
      "early@example.com",
      "middle@example.com",
      "mid-key@example.com",
      "erin@example.com",
      "late@example.com",
    ]);
  });

  it("keeps early long file-watch entry keys intact when keys alone exceed MAX_OUTSIDE_TEXT_CHARS", async () => {
    const pad = "a".repeat(250);
    const entries: Record<string, string> = {
      [`/inbox/${pad}/victim@example.com/${pad}/report.txt`]: "100:1",
    };
    for (let i = 0; i < 900; i += 1) {
      entries[`/inbox/${pad}/filler-${i}/${pad}/note.txt`] = "100:1";
    }
    const { ctx, call } = watchReadRun({
      checkedAt: "2026-11-25T07:00:00.000Z",
      outcome: "changed",
      fingerprint: "fp-files",
      entries,
      detail: null,
    });
    const result = await taskTools.schedule_list!(ctx, call("schedule_list"));
    const delivered = clipToolResultText(
      serializeToolResult(result, undefined, "schedule_list", {}),
    );
    expect(delivered).toContain("victim@example.com");
    expect(
      outsideOnlyTargets(
        { to: ["victim@example.com"] },
        { ownerWords: ["List schedules"], outsideText: ctx.state.outsideText },
      ),
    ).toEqual(["victim@example.com"]);
  });

  it("keeps early 122-char watch values and current-strategy raw prefixes that Pi delivers", async () => {
    const keyPad = "k".repeat(100);
    const earlyValue = `${"a".repeat(50)} mid-val@example.com ${"b".repeat(51)}`;
    expect(earlyValue).toHaveLength(122);
    const entries: Record<string, string> = {
      [`${keyPad}-0000`]: earlyValue,
    };
    for (let i = 1; i < 1_913; i += 1) {
      entries[`${keyPad}-${String(i).padStart(4, "0")}`] = `${"c".repeat(61)}${"d".repeat(61)}`;
    }
    const { ctx, call } = watchReadRun({
      checkedAt: "2026-11-25T07:00:00.000Z",
      outcome: "changed",
      fingerprint: "fp-many",
      entries,
      detail: null,
    });
    const result = await taskTools.schedule_list!(ctx, call("schedule_list"));
    const deliveredSelective = clipToolResultText(
      serializeToolResult(result, undefined, "schedule_list", {}),
    );
    const deliveredCurrent = clipToolResultText(
      serializeToolResult(result, "current", "schedule_list", {}),
    );
    expect(deliveredSelective).toContain("mid-val@example.com");
    expect(deliveredCurrent).toContain("mid-val@example.com");
    expect(
      outsideOnlyTargets(
        { to: ["mid-val@example.com"] },
        { ownerWords: ["List schedules"], outsideText: ctx.state.outsideText },
      ),
    ).toEqual(["mid-val@example.com"]);

    // Under the "current" context strategy, Pi delivers the raw unshortened head up to 12,000 chars.
    const rawEntries: Record<string, string> = {
      "item-0": `${"x".repeat(5_000)} raw-head@example.com ${"y".repeat(5_000)}`,
    };
    for (let i = 1; i < 1_913; i += 1) {
      rawEntries[`${keyPad}-${String(i).padStart(4, "0")}`] = `${"c".repeat(61)}${"d".repeat(61)}`;
    }
    const rawRun = watchReadRun({
      checkedAt: "2026-11-25T07:00:00.000Z",
      outcome: "changed",
      fingerprint: "fp-raw-head",
      entries: rawEntries,
      detail: null,
    });
    (rawRun.ctx.deps as { contextStrategy?: string }).contextStrategy = "current";
    const rawResult = await taskTools.schedule_list!(rawRun.ctx, rawRun.call("schedule_list"));
    const rawDeliveredCurrent = clipToolResultText(
      serializeToolResult(rawResult, "current", "schedule_list", {}),
    );
    expect(rawDeliveredCurrent).toContain("raw-head@example.com");
    expect(
      outsideOnlyTargets(
        { to: ["raw-head@example.com"] },
        { ownerWords: ["List schedules"], outsideText: rawRun.ctx.state.outsideText },
      ),
    ).toEqual(["raw-head@example.com"]);
  });

  it("bounds raw watch text before NFKC expansion so Unicode-heavy keys keep visible targets", async () => {
    // U+FDFA expands 18x under NFKC, so bounding after normalization would drop recipient@example.test.
    const expandingKey = `${"\uFDFA".repeat(3_000)} recipient@example.test ${"\uFDFA".repeat(27_000)}`;
    for (const contextStrategy of [undefined, "current"] as const) {
      const unicodeRun = watchReadRun({
        checkedAt: "2026-11-25T07:00:00.000Z",
        outcome: "changed",
        fingerprint: "fp-unicode",
        entries: { [expandingKey]: "100:1" },
        detail: null,
      });
      if (contextStrategy) {
        (unicodeRun.ctx.deps as { contextStrategy?: string }).contextStrategy = contextStrategy;
      }
      const unicodeResult = await taskTools.schedule_list!(
        unicodeRun.ctx,
        unicodeRun.call("schedule_list"),
      );
      expect(
        clipToolResultText(
          serializeToolResult(unicodeResult, contextStrategy, "schedule_list", {}),
        ),
      ).toContain("recipient@example.test");
      expect(
        outsideOnlyTargets(
          { to: ["recipient@example.test"] },
          { ownerWords: ["List schedules"], outsideText: unicodeRun.ctx.state.outsideText },
        ),
      ).toEqual(["recipient@example.test"]);
    }
  });

  it("prevents a later large ASCII or NFKC-expanding watch read from evicting an earlier target", async () => {
    for (const secondValue of ["z".repeat(MAX_OUTSIDE_TEXT_CHARS - 20), "\uFDFA".repeat(23_000)]) {
      for (const contextStrategy of [undefined, "current"] as const) {
        const firstRun = watchReadRun({
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "changed",
          fingerprint: "fp-first",
          entries: { "item-1": "Reply to earlier@example.test" },
          detail: null,
        });
        if (contextStrategy) {
          (firstRun.ctx.deps as { contextStrategy?: string }).contextStrategy = contextStrategy;
        }
        await taskTools.schedule_list!(firstRun.ctx, firstRun.call("schedule_list"));

        const secondRun = watchReadRun({
          checkedAt: "2026-11-25T07:01:00.000Z",
          outcome: "changed",
          fingerprint: "fp-second",
          entries: { "item-big": secondValue },
          detail: null,
        });
        if (contextStrategy) {
          (secondRun.ctx.deps as { contextStrategy?: string }).contextStrategy = contextStrategy;
        }
        secondRun.ctx.state.outsideText = firstRun.ctx.state.outsideText;
        await taskTools.schedule_list!(secondRun.ctx, secondRun.call("schedule_list"));
        expect(
          outsideOnlyTargets(
            { to: ["earlier@example.test"] },
            { ownerWords: ["List schedules"], outsideText: secondRun.ctx.state.outsideText },
          ),
        ).toEqual(["earlier@example.test"]);
      }
    }
  });

  it("decodes tracked watch item escapes without corrupting literal backslashes and keeps nested object keys", async () => {
    const shortReading = readItems(
      [
        {
          id: "msg-1",
          body: "Delivery address:\nrecipient@example.test",
          meta: { "nested-key@example.test": "pending" },
          title: "Order",
        },
      ],
      ["id", "body", "meta"],
    );
    const oversizedReading = readItems(
      [
        {
          id: "msg-big",
          body: `Delivery address:\nhead@example.test \\notices@example.test\n${"x".repeat(20_000)}`,
          title: `${"a".repeat(80)} \\title-tail@example.test`,
        },
      ],
      ["id", "body"],
    );
    for (const toolName of ["schedule_list", "task_catalog"] as const) {
      for (const contextStrategy of [undefined, "current"] as const) {
        const shortRun = watchReadRun({
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "changed",
          fingerprint: shortReading.fingerprint,
          entries: shortReading.entries,
          detail: shortReading.detail,
        });
        if (contextStrategy) {
          (shortRun.ctx.deps as { contextStrategy?: string }).contextStrategy = contextStrategy;
        }
        await taskTools[toolName]!(shortRun.ctx, shortRun.call(toolName));
        expect(
          outsideOnlyTargets(
            { to: ["recipient@example.test", "nested-key@example.test"] },
            { ownerWords: ["Check routines"], outsideText: shortRun.ctx.state.outsideText },
          ),
        ).toEqual(["recipient@example.test", "nested-key@example.test"]);

        const bigRun = watchReadRun({
          checkedAt: "2026-11-25T07:01:00.000Z",
          outcome: "changed",
          fingerprint: oversizedReading.fingerprint,
          entries: oversizedReading.entries,
          detail: oversizedReading.detail,
        });
        if (contextStrategy) {
          (bigRun.ctx.deps as { contextStrategy?: string }).contextStrategy = contextStrategy;
        }
        await taskTools[toolName]!(bigRun.ctx, bigRun.call(toolName));
        const expected =
          contextStrategy === "current"
            ? ["head@example.test", "notices@example.test"]
            : ["head@example.test", "notices@example.test", "title-tail@example.test"];
        expect(
          outsideOnlyTargets(
            { to: expected },
            { ownerWords: ["Check routines"], outsideText: bigRun.ctx.state.outsideText },
          ),
        ).toEqual(expected);
      }
    }
  });

  it("keeps raw item:-prefixed detail strings and entry keys untouched instead of unescaping them", async () => {
    for (const toolName of ["schedule_list", "task_catalog"] as const) {
      const { ctx, call } = watchReadRun({
        checkedAt: "2026-11-25T07:00:00.000Z",
        outcome: "changed",
        fingerprint: "fp-raw-item-prefix",
        detail: "item:Pay \\notices@example.test and \\bugs@example.test today",
        entries: {
          "item:Forward \\treasury@example.test": "ok",
        },
      });
      await taskTools[toolName]!(ctx, call(toolName));
      expect(
        outsideOnlyTargets(
          {
            to: ["notices@example.test", "bugs@example.test", "treasury@example.test"],
          },
          { ownerWords: ["Check routines"], outsideText: ctx.state.outsideText },
        ),
      ).toEqual(["notices@example.test", "bugs@example.test", "treasury@example.test"]);
    }
  });

  it.each(["schedule_list", "task_catalog"] as const)(
    "%s leaves the run untainted when watch lastCheck holds only fingerprint metadata",
    async (toolName) => {
      for (const watchState of [
        {
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "unchanged",
          fingerprint: "sha256:0123456789abcdef",
          detail: null,
        },
        {
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "unchanged",
          fingerprint: "sha256:0123456789abcdef",
          entries: {},
          detail: "   ",
        },
      ]) {
        const { ctx, call, finish } = watchReadRun(watchState);
        const result = await taskTools[toolName]!(ctx, call(toolName));
        expect(finish).toHaveBeenCalledWith(result);
        expect(ctx.state.tainted).toBe(false);
        expect(ctx.state.taintedBeyondOwnComputer).toBe(false);
        expect(ctx.state.outsideText).toBe("");
      }
    },
  );
});
