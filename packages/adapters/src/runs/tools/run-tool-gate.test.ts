import type * as Core from "@rakazo/core";
import {
  approvalEffectKey,
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import type * as Db from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimEffect,
  completeEffect,
  findRecordedEffect,
  recordEffect,
} from "../lifecycle/run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { taskTools } from "./run-tools-tasks.js";

const plans = vi.hoisted(() => [] as string[]);
const reviewOnly = vi.hoisted(() => [] as (boolean | undefined)[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      reviewOnly.push(input.reviewOnly);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect a person answers is where an ask begins; the test stops there.
const realRunEffects = vi.hoisted(() => ({
  findRecordedEffect: undefined as typeof findRecordedEffect | undefined,
  recordEffect: undefined as typeof recordEffect | undefined,
}));
vi.mock("../lifecycle/run-effects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle/run-effects.js")>();
  realRunEffects.findRecordedEffect = actual.findRecordedEffect;
  realRunEffects.recordEffect = actual.recordEffect;
  return {
    ...actual,
    claimEffect: vi.fn(async () => true),
    completeEffect: vi.fn(async () => true),
    findRecordedEffect: vi.fn(async () => undefined),
    recordEffect: vi.fn(async () => {
      throw new Error("asks the user");
    }),
  };
});

const loginUse = {
  kind: "login" as const,
  login: "work",
  site: "https://login.example.test",
  title: "login.example.test",
  fields: ["Password"],
  savedAt: "2026-09-01T00:00:01.000Z",
};

function gate(options: {
  trigger?: string;
  neverAsk?: boolean;
  rule?: "always_allow" | "deny";
  asks?: boolean;
}) {
  const args = { actions: [{ kind: "fill_secret", ref: "e1", secret: "work", field: "Password" }] };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
    name: "browser_act",
    args,
    executionId,
    connectorCall: { tool: "browser_act", args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "browser_act",
    fleetSummary: undefined,
    heldForApproval: false,
    settingsChange: false,
    ignoresAllowRules: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: options.asks === false ? undefined : loginUse,
  };
  const ctx = {
    deps: { prisma: {} },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: options.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () =>
        options.rule
          ? [{ effect: options.rule, matchKind: "tool", matchValue: "browser_act" }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: false,
        skipApprovals: Boolean(options.neverAsk),
      }),
    },
  };
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

describe("gateToolCall: a login that asks first", () => {
  beforeEach(() => {
    plans.length = 0;
  });

  it("asks the user every time in Ask and Auto, even over an Always allow rule", async () => {
    for (const options of [{}, { rule: "always_allow" as const }]) {
      plans.length = 0;
      expect(await gate(options)).toBe("asks the user");
      expect(plans).toEqual(["ask"]);
    }
  });

  it("runs it without asking in Never ask", async () => {
    plans.length = 0;
    await gate({ neverAsk: true });
    expect(plans).toEqual(["allow"]);
  });

  it("asks in a webhook run too, where the card expires if nobody answers", async () => {
    plans.length = 0;
    expect(await gate({ trigger: "webhook" })).toBe("asks the user");
    expect(plans).toEqual(["ask"]);
  });

  it("is refused by a rule that blocks the tool", async () => {
    expect(await gate({ rule: "deny" })).toEqual({
      result: { error: expect.stringContaining("is blocked in this space") },
    });
  });
});

describe("gateToolCall: typing into a page after outside content, in Auto", () => {
  const typed = (
    state: { pageUrl?: string; pageUrlUncertain?: boolean },
    actions: Record<string, unknown>[] = [{ kind: "fill", ref: "e2", text: "12 Rua Nova" }],
  ) => {
    const args = { actions };
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const request = {
      name: "browser_act",
      args,
      executionId,
      connectorCall: { tool: "browser_act", args, executionId, route: undefined },
      effectRequest: args,
      replayEffectToolName: "browser_act",
      heldForApproval: false,
      settingsChange: false,
      ignoresAllowRules: false,
    } as unknown as ToolRequest;
    const ctx = {
      deps: { prisma: {}, autoReview: {} },
      run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      thread: { id: "thread-1" },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: true },
      tools: { connector: new Map(), connectedPlugins: [] },
      state: {
        ...state,
        tainted: true,
        taintedBeyondOwnComputer: true,
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        searchResultUrls: new Set<string>(),
        loadTrustedSites: async () => new Set(["example.com"]),
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      },
    };
    return gateToolCall(ctx as never, request, undefined).catch(() => undefined);
  };

  beforeEach(() => {
    reviewOnly.length = 0;
  });

  it("leaves typing on a site the run was given alone, and judges it once a desktop action may have moved the page", async () => {
    await typed({ pageUrl: "https://shop.example.com/address" });
    await typed({ pageUrl: "https://shop.example.com/address", pageUrlUncertain: true });
    await typed({ pageUrl: "https://forms.example.net/" });
    expect(reviewOnly).toEqual([false, true, true]);
  });

  it("judges typing after a click in the same call, which can leave the page", async () => {
    await typed({ pageUrl: "https://shop.example.com/address" }, [
      { kind: "fill", ref: "e2", text: "12 Rua Nova" },
      { kind: "click", ref: "e3" },
    ]);
    await typed({ pageUrl: "https://shop.example.com/address" }, [
      { kind: "click", ref: "e9" },
      { kind: "fill", ref: "e2", text: "12 Rua Nova" },
    ]);
    expect(reviewOnly).toEqual([false, true]);
  });
});

describe("gateToolCall: schedule_cancel pinning, claiming, and legacy intended effects", () => {
  type StoredEffectRow = {
    id: string;
    runId: string;
    spaceId: string;
    kind: string;
    idempotencyKey: string;
    status: string;
    request: unknown;
    result?: unknown;
  };

  function scheduleGateFixture(options: {
    name?: "schedule_cancel" | "schedule_list" | "schedule_update";
    args: Record<string, unknown>;
    effectKeyArgs?: Record<string, unknown>;
    neverAsk?: boolean;
    heldForApproval?: boolean;
    routines?: Array<{ id: string; name: string }>;
    storedEffects?: StoredEffectRow[];
  }) {
    const name = options.name ?? "schedule_cancel";
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const request = {
      name,
      args: options.args,
      executionId,
      connectorCall: { tool: name, args: options.args, executionId, route: undefined },
      effectRequest: options.args,
      ...(options.effectKeyArgs ? { effectKeyArgs: options.effectKeyArgs } : {}),
      resolvedTool: undefined,
      catalogRemapped: false,
      nextApprovedTool: undefined,
      approvedEffectKey: undefined,
      replayEffectToolName: name,
      fleetSummary: undefined,
      heldForApproval: Boolean(options.heldForApproval),
      settingsChange: false,
      ignoresAllowRules: false,
      purchase: undefined,
      cardUse: undefined,
      loginUse: undefined,
    } as unknown as ToolRequest;
    const byKey = new Map((options.storedEffects ?? []).map((row) => [row.idempotencyKey, row]));
    const routineFindMany = vi.fn(async () => options.routines ?? []);
    const effectUpdateMany = vi.fn(async () => ({ count: 1 }));
    const effectCreate = vi.fn(async ({ data }: { data: StoredEffectRow }) => {
      const row = { ...data, id: `created-${byKey.size + 1}` };
      byKey.set(row.idempotencyKey, row);
      return row;
    });
    const ctx = {
      deps: {
        prisma: {
          routine: { findMany: routineFindMany },
          externalEffect: {
            findUnique: vi.fn(
              async ({ where }: { where: { idempotencyKey?: string; id?: string } }) =>
                where.idempotencyKey
                  ? (byKey.get(where.idempotencyKey) ?? null)
                  : ([...byKey.values()].find((row) => row.id === where.id) ?? null),
            ),
            findMany: vi.fn(async ({ where }: { where?: { status?: string; kind?: string } }) =>
              [...byKey.values()].filter(
                (row) =>
                  (where?.status === undefined || row.status === where.status) &&
                  (where?.kind === undefined || row.kind === where.kind),
              ),
            ),
            updateMany: effectUpdateMany,
            create: effectCreate,
          },
          run: { findUnique: vi.fn(async () => ({ status: "running" })) },
        },
        events: { append: vi.fn(async () => undefined) },
      },
      run: {
        id: "run-1",
        userId: "user-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        trigger: "user",
      },
      runId: "run-1",
      bot: { id: "bot-1", name: "Helper" },
      fleetRun: { spaceId: "space-1", botId: "bot-1", userId: "user-1" },
      thread: { id: "thread-1", groupId: null },
      context: { signal: new AbortController().signal },
      source: { ownerStartedRun: true },
      tools: { connector: new Map(), connectedPlugins: [] },
      state: {
        tainted: false,
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
        approval: { pausePending: false },
      },
      trust: {
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({
          enabled: false,
          skipApprovals: Boolean(options.neverAsk),
        }),
      },
    };
    return { ctx, request, routineFindMany, effectUpdateMany, effectCreate };
  }

  function useKeyedEffects() {
    vi.mocked(findRecordedEffect).mockImplementation((...args) =>
      realRunEffects.findRecordedEffect!(...args),
    );
    vi.mocked(recordEffect).mockImplementation((...args) => realRunEffects.recordEffect!(...args));
  }

  beforeEach(() => {
    vi.mocked(claimEffect).mockReset().mockResolvedValue(true);
    vi.mocked(completeEffect).mockReset().mockResolvedValue(true);
    vi.mocked(findRecordedEffect).mockReset().mockResolvedValue(undefined);
    vi.mocked(recordEffect)
      .mockReset()
      .mockImplementation(async () => {
        throw new Error("asks the user");
      });
  });

  it("pins routineId into effectRequest before recording a gated schedule_cancel approval", async () => {
    const { ctx, request, routineFindMany } = scheduleGateFixture({
      args: { name: "Daily check" },
      heldForApproval: true,
      routines: [{ id: "routine-1", name: "Daily check" }],
    });
    await expect(gateToolCall(ctx as never, request, undefined)).rejects.toThrow("asks the user");
    expect(routineFindMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", botId: "bot-1", name: "Daily check" },
      take: 2,
    });
    expect(vi.mocked(recordEffect)).toHaveBeenCalledWith(
      ctx.deps,
      ctx.run,
      "schedule_cancel",
      approvalEffectKey("run-1", "schedule_cancel", { name: "Daily check" }),
      { name: "Daily check", routineId: "routine-1" },
      request.executionId,
      ctx.state.effects.consumedIds,
      undefined,
      ctx.state.effects.counts,
    );
    expect(request.args).toEqual({ name: "Daily check", routineId: "routine-1" });
  });

  it("refuses a missing or ambiguous schedule_cancel before recording an effect or asking", async () => {
    const missing = scheduleGateFixture({
      args: { name: "Missing" },
      heldForApproval: true,
      routines: [],
    });
    await expect(gateToolCall(missing.ctx as never, missing.request, undefined)).resolves.toEqual({
      result: { error: "Schedule not found." },
    });
    expect(vi.mocked(recordEffect)).not.toHaveBeenCalled();
    expect(missing.ctx.state.effects.counts.size).toBe(0);

    const ambiguous = scheduleGateFixture({
      args: { name: "Daily check" },
      heldForApproval: true,
      routines: [
        { id: "routine-1", name: "Daily check" },
        { id: "routine-2", name: "Daily check" },
      ],
    });
    await expect(
      gateToolCall(ambiguous.ctx as never, ambiguous.request, undefined),
    ).resolves.toEqual({
      result: { error: 'More than one schedule is named "Daily check". Pass routineId instead.' },
    });
    expect(vi.mocked(recordEffect)).not.toHaveBeenCalled();
  });

  it("replays a completed schedule_cancel by keyed lookup even after a bot rename", async () => {
    useKeyedEffects();
    const key = approvalEffectKey("run-1", "schedule_cancel", {
      bot_id: "child",
      name: "Daily check",
    });
    const completed: StoredEffectRow = {
      id: "eff-1",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: key,
      status: "completed",
      request: {
        bot_id: "child",
        bot_name: "OldName",
        name: "Daily check",
        routineId: "routine-1",
      },
      result: { ok: true, routineId: "routine-1", name: "Daily check" },
    };
    const { ctx, request, routineFindMany, effectCreate } = scheduleGateFixture({
      args: { bot_id: "child", bot_name: "Renamed", name: "Daily check" },
      effectKeyArgs: { bot_id: "child", name: "Daily check" },
      heldForApproval: true,
      routines: [{ id: "routine-replacement", name: "Daily check" }],
      storedEffects: [completed],
    });
    await expect(gateToolCall(ctx as never, request, undefined)).resolves.toEqual({
      result: completed.result,
      replayed: true,
    });
    expect(routineFindMany).not.toHaveBeenCalled();
    expect(effectCreate).not.toHaveBeenCalled();
  });

  it("reconciles a completed legacy scoped schedule_cancel without creating a second effect", async () => {
    useKeyedEffects();
    const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
    const legacyKey = legacyScopedToolEffectIdempotencyKey(
      "run-1",
      "schedule_cancel",
      executionId,
      {
        name: "Daily check",
      },
    );
    const completed: StoredEffectRow = {
      id: "eff-legacy-done",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: legacyKey,
      status: "completed",
      request: { name: "Daily check" },
      result: { ok: true, routineId: "routine-old", name: "Daily check" },
    };
    const { ctx, request, routineFindMany, effectCreate } = scheduleGateFixture({
      args: { name: "Daily check" },
      heldForApproval: true,
      routines: [{ id: "routine-reused", name: "Daily check" }],
      storedEffects: [completed],
    });
    await expect(gateToolCall(ctx as never, request, undefined)).resolves.toEqual({
      result: completed.result,
      replayed: true,
    });
    expect(routineFindMany).not.toHaveBeenCalled();
    expect(effectCreate).not.toHaveBeenCalled();
  });

  it("claims an ungated schedule_cancel effect before returning the call to execute", async () => {
    useKeyedEffects();
    const { ctx, request } = scheduleGateFixture({
      args: { name: "Daily check" },
      neverAsk: true,
    });
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect("call" in outcome).toBe(true);
    if ("call" in outcome) {
      expect(outcome.call.claimedEffect).toBe(true);
    }
    expect(vi.mocked(claimEffect)).toHaveBeenCalledWith(ctx.deps, "run-1", "created-1", "intended");
  });

  it("restores pinned routineId when a duplicate intended schedule_cancel proceeds without approval", async () => {
    useKeyedEffects();
    const ungatedKey = approvalEffectKey("run-1", "schedule_cancel", { name: "Daily check" });
    const effect: StoredEffectRow = {
      id: "eff-pinned",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: ungatedKey,
      status: "intended",
      request: { name: "Daily check", routineId: "routine-1" },
    };
    const { ctx, request } = scheduleGateFixture({
      args: { name: "Daily check" },
      neverAsk: true,
      storedEffects: [effect],
    });
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect("call" in outcome).toBe(true);
    if ("call" in outcome) {
      expect(outcome.call.args).toEqual({ name: "Daily check", routineId: "routine-1" });
      expect(outcome.call.claimedEffect).toBe(true);
    }
  });

  it("settles a duplicate unpinned legacy intended schedule_cancel as uncertain", async () => {
    useKeyedEffects();
    const key = approvalEffectKey("run-1", "schedule_cancel", { name: "Daily check" });
    const effect: StoredEffectRow = {
      id: "eff-legacy",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: key,
      status: "intended",
      request: { name: "Daily check" },
    };
    const { ctx, request, effectUpdateMany } = scheduleGateFixture({
      args: { name: "Daily check" },
      heldForApproval: true,
      storedEffects: [effect],
    });
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(vi.mocked(claimEffect)).toHaveBeenCalledWith(
      ctx.deps,
      "run-1",
      "eff-legacy",
      "intended",
    );
    expect(effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-legacy", status: "executing" },
      data: expect.objectContaining({ status: "uncertain" }),
    });
    expect(outcome).toMatchObject({
      replayed: true,
      result: { uncertain: true },
    });
  });

  it("refuses a duplicate unpinned legacy intended managed-routine request", async () => {
    useKeyedEffects();
    const key = approvalEffectKey("run-1", "schedule_list", { bot_id: "child" });
    const effect: StoredEffectRow = {
      id: "eff-bot",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: key,
      status: "intended",
      request: { bot_name: "Child" },
    };
    const { ctx, request, effectUpdateMany } = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child", bot_name: "Child" },
      effectKeyArgs: { bot_id: "child" },
      heldForApproval: true,
      storedEffects: [effect],
    });
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      result: {
        error:
          "This pending request named the bot without its id; call the tool again with bot_id so it targets the exact bot.",
      },
    });
    expect(effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-bot", status: "intended" },
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ error: expect.stringContaining("bot_id") }),
      }),
    });
  });

  it("replays a completed previous-release managed cancellation in Never ask after a bot rename without a checkpoint", async () => {
    useKeyedEffects();
    const prevKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      bot_name: "Old Child",
      name: "Daily check",
    });
    const effect: StoredEffectRow = {
      id: "eff-renamed",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: prevKey,
      status: "completed",
      request: { bot_id: "child", name: "Daily check" },
      result: { ok: true, routineId: "routine-old", name: "Daily check" },
    };
    const { ctx, request } = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily check" },
      neverAsk: true,
      storedEffects: [effect],
    });
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-old", name: "Daily check" },
    });
    expect(vi.mocked(claimEffect)).not.toHaveBeenCalled();
  });

  it("replays a legacy scoped managed cancellation in Never ask without creating a second effect", async () => {
    useKeyedEffects();
    const executionId = JSON.stringify(["pi-tool", "main", "call-legacy-never-ask"]);
    const rawRequest = { bot_name: "Child", name: "Daily check" };
    const legacyKey = legacyScopedToolEffectIdempotencyKey(
      "run-1",
      "schedule_cancel",
      executionId,
      rawRequest,
    );
    const effect: StoredEffectRow = {
      id: "eff-legacy-never-ask",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: legacyKey,
      status: "completed",
      request: rawRequest,
      result: { ok: true, routineId: "routine-old", name: "Daily check" },
    };
    const { ctx, request } = scheduleGateFixture({
      args: rawRequest,
      neverAsk: true,
      storedEffects: [effect],
    });
    request.executionId = executionId;
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-old", name: "Daily check" },
    });
    expect(vi.mocked(claimEffect)).not.toHaveBeenCalled();
  });

  it("replays two previous-release cancellations across a bot rename in creation order and matches padded bot names", async () => {
    useKeyedEffects();
    const firstKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      bot_name: "Old Child",
      name: "Daily check",
    });
    const secondKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      bot_name: "Renamed Child",
      name: "Daily check",
    });
    const storedEffects: StoredEffectRow[] = [
      {
        id: "eff-first",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: firstKey,
        status: "completed",
        request: { bot_name: " Old Child ", name: "Daily check" },
        result: { ok: true, routineId: "routine-1", name: "Daily check" },
      },
      {
        id: "eff-second",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: secondKey,
        status: "completed",
        request: { bot_id: "child", name: "Daily check" },
        result: { ok: true, routineId: "routine-2", name: "Daily check" },
      },
    ];
    const { ctx } = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily check" },
      neverAsk: true,
      storedEffects,
    });
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ctx.trust, { receivedOutsideMessage: async () => false });

    const call = (id: string) =>
      ({
        name: "schedule_cancel",
        args: { bot_id: "child", name: "Daily check" },
        executionId: JSON.stringify(["pi-tool", "main", id]),
        connectorCall: {
          name: "schedule_cancel",
          args: { bot_id: "child", name: "Daily check" },
        },
        effectRequest: { bot_id: "child", name: "Daily check" },
        resolvedTool: undefined,
        catalogRemapped: false,
        nextApprovedTool: undefined,
        approvedEffectKey: undefined,
        replayEffectToolName: "schedule_cancel",
        fleetSummary: undefined,
        heldForApproval: false,
        settingsChange: false,
        ignoresAllowRules: false,
        purchase: undefined,
        cardUse: undefined,
        loginUse: undefined,
      }) as unknown as ToolRequest;

    const firstReq = call("retry-1");
    await expect(prepareToolRequest(ctx as never, firstReq)).resolves.toBeUndefined();
    expect(await gateToolCall(ctx as never, firstReq, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-1", name: "Daily check" },
    });

    const secondReq = call("retry-2");
    await expect(prepareToolRequest(ctx as never, secondReq)).resolves.toBeUndefined();
    expect(await gateToolCall(ctx as never, secondReq, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-2", name: "Daily check" },
    });
    expect(vi.mocked(claimEffect)).not.toHaveBeenCalled();
  });

  it("replays a legacy scoped self-bot cancellation in Never ask when the caller passes its own bot_id", async () => {
    useKeyedEffects();
    const executionId = JSON.stringify(["pi-tool", "main", "call-self-legacy"]);
    const rawRequest = { bot_id: "bot-1", name: "Daily check" };
    const legacyKey = legacyScopedToolEffectIdempotencyKey(
      "run-1",
      "schedule_cancel",
      executionId,
      rawRequest,
    );
    const effect: StoredEffectRow = {
      id: "eff-self-legacy",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: legacyKey,
      status: "completed",
      request: rawRequest,
      result: { ok: true, routineId: "routine-self", name: "Daily check" },
    };
    const { ctx, request } = scheduleGateFixture({
      args: rawRequest,
      neverAsk: true,
      storedEffects: [effect],
    });
    request.executionId = executionId;
    Object.assign(ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });

    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-self", name: "Daily check" },
    });
    expect(vi.mocked(claimEffect)).not.toHaveBeenCalled();
  });

  it("replays a reconciled previous-release schedule_list in Never ask instead of re-querying a taken bot name", async () => {
    useKeyedEffects();
    const prevKey = toolEffectIdempotencyKey("run-1", "schedule_list", {
      bot_id: "child",
      bot_name: "Old Child",
    });
    const effect: StoredEffectRow = {
      id: "eff-list-renamed",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: prevKey,
      status: "completed",
      request: { bot_name: " Old Child " },
      result: { routines: [{ id: "routine-child", name: "Child digest" }] },
    };
    const { ctx, request } = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child" },
      neverAsk: true,
      storedEffects: [effect],
    });
    const bots = [
      { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
      { id: "impostor", name: "Old Child", thread: { id: "i-t" } },
    ];
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(
          async ({ where }: { where?: { id?: string; name?: { equals?: string } } }) =>
            bots.filter(
              (row) =>
                (!where?.id || row.id === where.id) &&
                (!where?.name?.equals ||
                  row.name.toLowerCase() === where.name.equals.toLowerCase()),
            ),
        ),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      replayed: true,
      result: { routines: [{ id: "routine-child", name: "Child digest" }] },
    });
  });

  it("persists approved schedule_list results via call.finish and settles legacy executing rows as uncertain", async () => {
    useKeyedEffects();
    const approvedKey = approvalEffectKey("run-1", "schedule_list", { bot_id: "child" });
    const approvedEffect: StoredEffectRow = {
      id: "eff-list-approved",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: approvedKey,
      status: "approved",
      request: { bot_id: "child", bot_name: "Child" },
    };
    const { ctx, request } = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child", bot_name: "Child" },
      effectKeyArgs: { bot_id: "child" },
      heldForApproval: true,
      storedEffects: [approvedEffect],
    });
    request.nextApprovedTool = "schedule_list";
    request.approvedEffectKey = approvedKey;
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: {
        findMany: vi.fn(async () => [
          {
            id: "routine-1",
            name: "Daily digest",
            prompt: "Summarize updates",
            active: true,
            crons: ["0 9 * * *"],
            events: [],
            watch: null,
            watchState: null,
            threadId: "c-t",
            nextRunAt: null,
            lastRunAt: null,
          },
        ]),
      },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });

    const gated = await gateToolCall(ctx as never, request, undefined);
    expect("call" in gated).toBe(true);
    if (!("call" in gated)) return;
    const listed = await taskTools.schedule_list!(ctx as never, gated.call);
    expect(vi.mocked(completeEffect)).toHaveBeenCalledWith(
      ctx.deps,
      "eff-list-approved",
      "executing",
      listed,
    );

    // An existing previous-release schedule_list row left in `executing` settles as uncertain on retry.
    const prevExecKey = toolEffectIdempotencyKey("run-1", "schedule_list", {
      bot_id: "child",
      bot_name: "Old Child",
    });
    const stuckEffect: StoredEffectRow = {
      id: "eff-list-stuck",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: prevExecKey,
      status: "executing",
      request: { bot_name: " Old Child " },
    };
    const retryFixture = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child" },
      neverAsk: true,
      storedEffects: [stuckEffect],
    });
    Object.assign(retryFixture.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(retryFixture.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(retryFixture.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(retryFixture.ctx as never, retryFixture.request),
    ).resolves.toBeUndefined();
    const retryOutcome = await gateToolCall(
      retryFixture.ctx as never,
      retryFixture.request,
      undefined,
    );
    expect(retryOutcome).toMatchObject({ replayed: true, result: { uncertain: true } });
    expect(retryFixture.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-list-stuck", status: "executing" },
      data: expect.objectContaining({ status: "uncertain" }),
    });
  });

  it("reconciles a name-only cancellation retry before live resolution when another bot took the old name", async () => {
    useKeyedEffects();
    const prevKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      bot_name: "Old Child",
      name: "Daily check",
    });
    const effect: StoredEffectRow = {
      id: "eff-name-takeover",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: prevKey,
      status: "completed",
      request: { bot_name: "Old Child", name: "Daily check" },
      result: { ok: true, routineId: "routine-child", name: "Daily check" },
    };
    const { ctx, request } = scheduleGateFixture({
      args: { bot_name: "Old Child", name: "Daily check" },
      neverAsk: true,
      storedEffects: [effect],
    });
    const findBots = vi.fn(async () => [
      { id: "impostor", name: "Old Child", thread: { id: "i-t" } },
    ]);
    Object.assign(ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findBots,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    expect(findBots).not.toHaveBeenCalled();
    const outcome = await gateToolCall(ctx as never, request, undefined);
    expect(outcome).toEqual({
      replayed: true,
      result: { ok: true, routineId: "routine-child", name: "Daily check" },
    });
    expect(vi.mocked(claimEffect)).not.toHaveBeenCalled();
  });

  it("matches padded schedule_cancel selectors, preserves bot-name case, and keeps self-bot name selectors on receipts", async () => {
    useKeyedEffects();
    // Padded name + empty routineId matches `Ops`, while case-distinct `ops` does not.
    const opsKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "ops-1",
      name: "Daily check",
    });
    const opsReceipt: StoredEffectRow = {
      id: "eff-ops",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: opsKey,
      status: "completed",
      request: { bot_id: "ops-1", bot_name: "Ops", routineId: "r-ops", name: "Daily check" },
      result: { ok: true, routineId: "r-ops", name: "Daily check" },
    };
    const paddedFixture = scheduleGateFixture({
      args: { bot_name: " Ops ", routineId: "", name: " Daily check " },
      neverAsk: true,
      storedEffects: [opsReceipt],
    });
    const findBotsPadded = vi.fn(async () => [
      { id: "impostor", name: "Ops", thread: { id: "i-t" } },
    ]);
    Object.assign(paddedFixture.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findBotsPadded,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(paddedFixture.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(paddedFixture.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(paddedFixture.ctx as never, paddedFixture.request),
    ).resolves.toBeUndefined();
    expect(findBotsPadded).not.toHaveBeenCalled();
    expect(
      await gateToolCall(paddedFixture.ctx as never, paddedFixture.request, undefined),
    ).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-ops", name: "Daily check" },
    });

    // Case-distinct `ops` must not consume the `Ops` receipt.
    const lowerFixture = scheduleGateFixture({
      args: { bot_name: "ops", name: "Daily check" },
      neverAsk: true,
      storedEffects: [opsReceipt],
    });
    const findBotsLower = vi.fn(async () => [
      { id: "ops-lower", name: "ops", thread: { id: "l-t" } },
    ]);
    Object.assign(lowerFixture.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findBotsLower,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(lowerFixture.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(lowerFixture.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(lowerFixture.ctx as never, lowerFixture.request),
    ).resolves.toBeUndefined();
    expect(findBotsLower).toHaveBeenCalledOnce();
    const lowerOutcome = await gateToolCall(
      lowerFixture.ctx as never,
      lowerFixture.request,
      undefined,
    );
    expect("call" in lowerOutcome).toBe(true);
    if ("call" in lowerOutcome) {
      expect(lowerOutcome.call.args).toEqual({
        bot_id: "ops-lower",
        bot_name: "ops",
        name: "Daily check",
      });
    }

    // Naming the current bot stores its selector in the receipt so a rename + takeover retry replays.
    const selfStored: StoredEffectRow[] = [];
    const selfFirst = scheduleGateFixture({
      args: { bot_name: "Ops", name: "Daily check" },
      neverAsk: true,
      storedEffects: selfStored,
    });
    Object.assign(selfFirst.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "bot-1", name: "Ops", thread: { id: "t-1" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(selfFirst.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(selfFirst.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(selfFirst.ctx as never, selfFirst.request),
    ).resolves.toBeUndefined();
    expect(selfFirst.request.args).toEqual({ name: "Daily check" });
    expect(selfFirst.request.effectRequest).toEqual({
      bot_id: "bot-1",
      bot_name: "Ops",
      name: "Daily check",
    });
    const selfFirstOutcome = await gateToolCall(
      selfFirst.ctx as never,
      selfFirst.request,
      undefined,
    );
    expect("call" in selfFirstOutcome).toBe(true);
    if (!("call" in selfFirstOutcome)) throw new Error("expected self-bot gate call");
    expect(selfFirstOutcome.call.applied).toBeDefined();
    const appliedEffect = selfFirstOutcome.call.applied!.effect;
    selfStored.push({
      id: appliedEffect.id,
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: appliedEffect.idempotencyKey,
      status: "completed",
      request: appliedEffect.request,
      result: { ok: true, routineId: "r-self-ops", name: "Daily check" },
    });

    // Now bot-1 is renamed and another bot takes "Ops"; checkpointless retry still replays bot-1's receipt.
    const selfRetry = scheduleGateFixture({
      args: { bot_name: "Ops", name: "Daily check" },
      neverAsk: true,
      storedEffects: selfStored,
    });
    const findBotsTakeover = vi.fn(async () => [
      { id: "impostor", name: "Ops", thread: { id: "i-t" } },
    ]);
    Object.assign(selfRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findBotsTakeover,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(selfRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(selfRetry.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(selfRetry.ctx as never, selfRetry.request),
    ).resolves.toBeUndefined();
    expect(findBotsTakeover).not.toHaveBeenCalled();
    expect(await gateToolCall(selfRetry.ctx as never, selfRetry.request, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-self-ops", name: "Daily check" },
    });

    // An ID-selected cancellation receipt that also carried an ignored name must not match a name-only call.
    const idSelectedKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "ops-1",
      routineId: "r-daily",
      name: "Weekly",
    });
    const idSelectedReceipt: StoredEffectRow = {
      id: "eff-id-selected",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: idSelectedKey,
      status: "completed",
      request: { bot_id: "ops-1", bot_name: "Ops", routineId: "r-daily", name: "Weekly" },
      result: { ok: true, routineId: "r-daily", name: "Daily" },
    };
    const nameOnlyCall = scheduleGateFixture({
      args: { bot_name: "Ops", routineId: "", name: " Weekly " },
      neverAsk: true,
      storedEffects: [idSelectedReceipt],
    });
    const findOps = vi.fn(async () => [{ id: "ops-1", name: "Ops", thread: { id: "o-t" } }]);
    Object.assign(nameOnlyCall.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findOps,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(nameOnlyCall.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(nameOnlyCall.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(nameOnlyCall.ctx as never, nameOnlyCall.request),
    ).resolves.toBeUndefined();
    expect(findOps).toHaveBeenCalledOnce();
    const nameOnlyOutcome = await gateToolCall(
      nameOnlyCall.ctx as never,
      nameOnlyCall.request,
      undefined,
    );
    expect("call" in nameOnlyOutcome).toBe(true);
    if (!("call" in nameOnlyOutcome)) throw new Error("expected fresh call for Weekly");
    expect(nameOnlyOutcome.call.args).toEqual({
      bot_id: "ops-1",
      bot_name: "Ops",
      routineId: "",
      name: " Weekly ",
    });

    // A pinned receipt created from padded args still reconciles a trimmed retry after name takeover,
    // and saving a checkpoint during recovery keeps the reconciled effect's original fingerprint.
    const paddedCreated: StoredEffectRow[] = [];
    const paddedCreate = scheduleGateFixture({
      args: { bot_name: "Ops", routineId: "", name: " Daily " },
      heldForApproval: true,
      storedEffects: paddedCreated,
    });
    Object.assign(paddedCreate.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "ops-1", name: "Ops", thread: { id: "o-t" } }]),
      },
      routine: {
        findMany: vi.fn(async () => [{ id: "r-daily", name: "Daily", threadId: "o-t" }]),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(paddedCreate.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(paddedCreate.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(paddedCreate.ctx as never, paddedCreate.request),
    ).resolves.toBeUndefined();
    const createOutcome = await gateToolCall(
      paddedCreate.ctx as never,
      paddedCreate.request,
      undefined,
    );
    expect("result" in createOutcome).toBe(true);
    const recordedCall = vi.mocked(recordEffect).mock.calls.at(-1);
    expect(recordedCall).toBeDefined();
    const createdKey = recordedCall![3];
    const createdRequest = recordedCall![4];
    expect(createdKey).toBe(
      approvalEffectKey("run-1", "schedule_cancel", { bot_id: "ops-1", name: "Daily" }),
    );
    paddedCreated.push({
      id: "eff-padded-pinned",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: createdKey,
      status: "intended",
      request: createdRequest,
    });

    // Recovery #1 after ops-1 is renamed and impostor takes "Ops": trimmed retry reconciles the
    // pinned receipt and records its original fingerprint (not the pinned args fingerprint) for
    // the next checkpoint.
    const trimmedRecovery = scheduleGateFixture({
      args: { bot_name: "Ops", name: "Daily" },
      heldForApproval: true,
      storedEffects: paddedCreated,
    });
    const findImpostor = vi.fn(async (query?: { where?: { id?: string; name?: string } }) => {
      if (query?.where?.id === "ops-1") {
        return [{ id: "ops-1", name: "OpsRenamed", thread: { id: "o-t" } }];
      }
      return [{ id: "impostor", name: "Ops", thread: { id: "i-t" } }];
    });
    Object.assign(trimmedRecovery.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findImpostor,
      },
      routine: {
        findFirst: vi.fn(async () => ({ id: "r-daily", name: "Daily", threadId: "o-t" })),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(trimmedRecovery.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(trimmedRecovery.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(trimmedRecovery.ctx as never, trimmedRecovery.request),
    ).resolves.toBeUndefined();
    expect(findImpostor).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "ops-1" }) }),
    );
    expect(findImpostor).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ name: "Ops" }) }),
    );
    await gateToolCall(trimmedRecovery.ctx as never, trimmedRecovery.request, undefined);
    const occurrences = trimmedRecovery.ctx.state.effects.occurrences as Array<{
      executionId: string;
      fingerprint: string;
      occurrence: number;
    }>;
    const savedOccurrence = occurrences.findLast(
      (entry) => entry.executionId === trimmedRecovery.request.executionId,
    );
    expect(savedOccurrence).toEqual({
      executionId: trimmedRecovery.request.executionId,
      fingerprint: createdKey,
      occurrence: 0,
    });
  });

  it("reconciles raw-selector own-bot and bot_name-only previous-release cancellations without conflating name and routineId keys", async () => {
    useKeyedEffects();
    // Own-bot raw-selector receipt (both without bot_id and with self bot_id) replays in Never ask.
    const rawOwnKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      routineId: "",
      name: " Daily ",
    });
    const rawOwnReceipt: StoredEffectRow = {
      id: "eff-raw-own",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: rawOwnKey,
      status: "completed",
      request: { routineId: "", name: " Daily " },
      result: { ok: true, routineId: "r-own-old", name: "Daily" },
    };
    for (const callerArgs of [
      { routineId: "", name: " Daily " },
      { bot_id: "bot-1", routineId: "", name: " Daily " },
    ]) {
      const ownFixture = scheduleGateFixture({
        args: callerArgs,
        neverAsk: true,
        storedEffects: [rawOwnReceipt],
      });
      Object.assign(ownFixture.ctx.deps.prisma, {
        steeringMessage: { findFirst: vi.fn(async () => null) },
      });
      await expect(
        prepareToolRequest(ownFixture.ctx as never, ownFixture.request),
      ).resolves.toBeUndefined();
      expect(await gateToolCall(ownFixture.ctx as never, ownFixture.request, undefined)).toEqual({
        replayed: true,
        result: { ok: true, routineId: "r-own-old", name: "Daily" },
      });
    }

    // Managed bot_name-only previous-release padded receipt replays on a trimmed bot_id retry.
    const prevPaddedKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      bot_name: "Old Child",
      routineId: "",
      name: " Daily ",
    });
    const prevPaddedReceipt: StoredEffectRow = {
      id: "eff-prev-padded",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: prevPaddedKey,
      status: "completed",
      request: { bot_name: "Old Child", routineId: "", name: " Daily " },
      result: { ok: true, routineId: "r-child-old", name: "Daily" },
    };
    const managedTrimmed = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily" },
      neverAsk: true,
      storedEffects: [prevPaddedReceipt],
    });
    Object.assign(managedTrimmed.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(managedTrimmed.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(managedTrimmed.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(managedTrimmed.ctx as never, managedTrimmed.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(managedTrimmed.ctx as never, managedTrimmed.request, undefined),
    ).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-child-old", name: "Daily" },
    });

    // An explicit routineId call must not consume an earlier modern name-selected receipt.
    const modernNameKey = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      name: "Daily",
    });
    const modernNameReceipt: StoredEffectRow = {
      id: "eff-modern-name",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: modernNameKey,
      status: "completed",
      request: { bot_id: "child", bot_name: "Child", routineId: "r-1", name: "Daily" },
      result: { ok: true, routineId: "r-1", name: "Daily" },
    };
    const explicitIdCall = scheduleGateFixture({
      args: { bot_id: "child", routineId: "r-1" },
      neverAsk: true,
      storedEffects: [modernNameReceipt],
    });
    Object.assign(explicitIdCall.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(explicitIdCall.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(explicitIdCall.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(explicitIdCall.ctx as never, explicitIdCall.request),
    ).resolves.toBeUndefined();
    const explicitIdOutcome = await gateToolCall(
      explicitIdCall.ctx as never,
      explicitIdCall.request,
      undefined,
    );
    expect("call" in explicitIdOutcome).toBe(true);
  });

  it("replays trimmed own-bot retries against named-self and blank-selector previous-release receipts", async () => {
    useKeyedEffects();
    const namedSelfReceipt: StoredEffectRow = {
      id: "eff-named-self-raw",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        routineId: "",
        name: " Daily ",
      }),
      status: "completed",
      request: { bot_name: "SelfBot", routineId: "", name: " Daily " },
      result: { ok: true, routineId: "r-named-self", name: "Daily" },
    };
    const blankSelectorReceipt: StoredEffectRow = {
      id: "eff-blank-selector-raw",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        bot_id: "",
        bot_name: "",
        routineId: "",
        name: " Daily ",
      }),
      status: "completed",
      request: { bot_id: "", bot_name: "", routineId: "", name: " Daily " },
      result: { ok: true, routineId: "r-blank-selector", name: "Daily" },
    };
    const childNamedReceipt: StoredEffectRow = {
      id: "eff-child-named-raw",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        bot_id: "child",
        bot_name: "ChildBot",
        routineId: "",
        name: " Daily ",
      }),
      status: "completed",
      request: { bot_name: "ChildBot", routineId: "", name: " Daily " },
      result: { ok: true, routineId: "r-child", name: "Daily" },
    };

    for (const [receipt, expectedId] of [
      [namedSelfReceipt, "r-named-self"],
      [blankSelectorReceipt, "r-blank-selector"],
    ] as const) {
      for (const callerArgs of [
        { name: "Daily" },
        { bot_id: "bot-1", name: "Daily" },
        { bot_name: "SelfBot", name: "Daily" },
      ]) {
        const retry = scheduleGateFixture({
          args: callerArgs,
          neverAsk: true,
          storedEffects: [childNamedReceipt, receipt],
        });
        Object.assign(retry.ctx.deps.prisma, {
          bot: {
            findUnique: vi.fn(async () => ({ fleetManagement: true })),
            findMany: vi.fn(async () => [{ id: "bot-1", name: "SelfBot", thread: { id: "t-1" } }]),
          },
          steeringMessage: { findFirst: vi.fn(async () => null) },
        });
        Object.assign(retry.ctx, {
          fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
        });
        Object.assign(retry.ctx.trust, { receivedOutsideMessage: async () => false });
        await expect(
          prepareToolRequest(retry.ctx as never, retry.request),
        ).resolves.toBeUndefined();
        expect(await gateToolCall(retry.ctx as never, retry.request, undefined)).toEqual({
          replayed: true,
          result: { ok: true, routineId: expectedId, name: "Daily" },
        });
      }
    }

    // Own-bot retry must never match a child bot's named receipt.
    const ownOnly = scheduleGateFixture({
      args: { name: "Daily" },
      neverAsk: true,
      storedEffects: [childNamedReceipt],
    });
    Object.assign(ownOnly.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      prepareToolRequest(ownOnly.ctx as never, ownOnly.request),
    ).resolves.toBeUndefined();
    const ownOnlyOutcome = await gateToolCall(ownOnly.ctx as never, ownOnly.request, undefined);
    expect("call" in ownOnlyOutcome).toBe(true);
  });

  it("replays a completed managed schedule_list by bot_id in Never ask and keeps mixed-release replay order", async () => {
    useKeyedEffects();
    const completedList: StoredEffectRow = {
      id: "eff-list-child",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", { bot_id: "child" }),
      status: "completed",
      request: { bot_id: "child", bot_name: "Child" },
      result: { routines: [{ id: "r-saved", name: "Saved routine" }] },
    };
    const listRetry = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child" },
      neverAsk: true,
      storedEffects: [completedList],
    });
    Object.assign(listRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(listRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(listRetry.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(listRetry.ctx as never, listRetry.request),
    ).resolves.toBeUndefined();
    expect(await gateToolCall(listRetry.ctx as never, listRetry.request, undefined)).toEqual({
      replayed: true,
      result: { routines: [{ id: "r-saved", name: "Saved routine" }] },
    });

    // Mixed-release managed cancellations: base-release receipt followed by canonical receipt
    // must replay oldest-first on a checkpointless retry.
    const mixedManaged: StoredEffectRow[] = [
      {
        id: "eff-1-base",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
          bot_id: "child",
          bot_name: "Child",
          name: "Daily",
        }),
        status: "completed",
        request: { bot_id: "child", name: "Daily" },
        result: { ok: true, routineId: "r-first-base", name: "Daily" },
      },
      {
        id: "eff-2-canonical",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
          bot_id: "child",
          name: "Daily",
        }),
        status: "completed",
        request: { bot_id: "child", bot_name: "Child", routineId: "r-second-new", name: "Daily" },
        result: { ok: true, routineId: "r-second-new", name: "Daily" },
      },
    ];
    for (const retryArgs of [
      { bot_id: "child", name: "Daily" },
      { bot_name: "Child", name: "Daily" },
    ]) {
      const first = scheduleGateFixture({
        args: retryArgs,
        neverAsk: true,
        storedEffects: mixedManaged,
      });
      Object.assign(first.ctx.deps.prisma, {
        bot: {
          findUnique: vi.fn(async () => ({ fleetManagement: true })),
          findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
        },
        steeringMessage: { findFirst: vi.fn(async () => null) },
      });
      Object.assign(first.ctx, {
        fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      });
      Object.assign(first.ctx.trust, { receivedOutsideMessage: async () => false });

      await expect(prepareToolRequest(first.ctx as never, first.request)).resolves.toBeUndefined();
      expect(await gateToolCall(first.ctx as never, first.request, undefined)).toEqual({
        replayed: true,
        result: { ok: true, routineId: "r-first-base", name: "Daily" },
      });

      const secondRequest: ToolRequest = {
        ...first.request,
        executionId: "exec-second",
        args: retryArgs,
        effectRequest: retryArgs,
        effectKeyArgs: undefined,
        reconciledEffectKey: undefined,
        preserveEffectRequest: undefined,
      };
      await expect(prepareToolRequest(first.ctx as never, secondRequest)).resolves.toBeUndefined();
      expect(await gateToolCall(first.ctx as never, secondRequest, undefined)).toEqual({
        replayed: true,
        result: { ok: true, routineId: "r-second-new", name: "Daily" },
      });
    }
  });

  it("reconciles a base-release child cancellation saved with blank bot_name after rename", async () => {
    useKeyedEffects();
    const blankBotNameReceipt: StoredEffectRow = {
      id: "eff-blank-bot-name",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        bot_id: "child",
        bot_name: "Old Child",
        name: "Daily",
      }),
      status: "completed",
      request: { bot_id: "child", bot_name: " ", name: "Daily" },
      result: { ok: true, routineId: "r-blank-bot-name", name: "Daily" },
    };
    const blankBotNameRetry = scheduleGateFixture({
      args: { bot_id: "child", bot_name: " ", name: "Daily" },
      neverAsk: true,
      storedEffects: [blankBotNameReceipt],
    });
    Object.assign(blankBotNameRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(blankBotNameRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(blankBotNameRetry.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(blankBotNameRetry.ctx as never, blankBotNameRetry.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(blankBotNameRetry.ctx as never, blankBotNameRetry.request, undefined),
    ).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-blank-bot-name", name: "Daily" },
    });
  });

  it("replays an older blank-selector own-bot cancellation before a newer named-self receipt", async () => {
    useKeyedEffects();
    const mixedOwn: StoredEffectRow[] = [
      {
        id: "eff-own-1-blank",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
          bot_id: "",
          bot_name: "",
          name: "Daily",
        }),
        status: "completed",
        request: { bot_id: "", bot_name: "", name: "Daily" },
        result: { ok: true, routineId: "r-own-first", name: "Daily" },
      },
      {
        id: "eff-own-2-named",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", { name: "Daily" }),
        status: "completed",
        request: { bot_id: "bot-1", bot_name: "SelfBot", routineId: "r-own-second", name: "Daily" },
        result: { ok: true, routineId: "r-own-second", name: "Daily" },
      },
    ];
    const ownNamedRetry = scheduleGateFixture({
      args: { bot_name: "SelfBot", name: "Daily" },
      neverAsk: true,
      storedEffects: mixedOwn,
    });
    Object.assign(ownNamedRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "bot-1", name: "SelfBot", thread: { id: "t-1" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(ownNamedRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(ownNamedRetry.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(ownNamedRetry.ctx as never, ownNamedRetry.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(ownNamedRetry.ctx as never, ownNamedRetry.request, undefined),
    ).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-own-first", name: "Daily" },
    });
    const ownNamedSecond: ToolRequest = {
      ...ownNamedRetry.request,
      executionId: "exec-own-second",
      args: { bot_name: "SelfBot", name: "Daily" },
      effectRequest: { bot_name: "SelfBot", name: "Daily" },
      effectKeyArgs: undefined,
      reconciledEffectKey: undefined,
      preserveEffectRequest: undefined,
    };
    await expect(
      prepareToolRequest(ownNamedRetry.ctx as never, ownNamedSecond),
    ).resolves.toBeUndefined();
    expect(await gateToolCall(ownNamedRetry.ctx as never, ownNamedSecond, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-own-second", name: "Daily" },
    });
  });

  it("replays a legacy cancellation before canonical occurrence 0 and keeps legacy consumption across saved occurrences", async () => {
    useKeyedEffects();
    const legacyThenCanonical: StoredEffectRow[] = [
      {
        id: "eff-legacy-first",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: "legacy-scoped-key-1",
        status: "completed",
        request: { name: "Daily" },
        result: { ok: true, routineId: "r-legacy-first", name: "Daily" },
      },
      {
        id: "eff-canonical-second",
        runId: "run-1",
        spaceId: "space-1",
        kind: "schedule_cancel",
        idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", { name: "Daily" }),
        status: "completed",
        request: { routineId: "r-canonical-second", name: "Daily" },
        result: { ok: true, routineId: "r-canonical-second", name: "Daily" },
      },
    ];
    const legacyOrder = scheduleGateFixture({
      args: { name: "Daily" },
      neverAsk: true,
      storedEffects: legacyThenCanonical,
    });
    Object.assign(legacyOrder.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      prepareToolRequest(legacyOrder.ctx as never, legacyOrder.request),
    ).resolves.toBeUndefined();
    expect(await gateToolCall(legacyOrder.ctx as never, legacyOrder.request, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-legacy-first", name: "Daily" },
    });

    // Simulate a new worker restoring saved effectOccurrences from the checkpoint after call 1.
    const restoredWorker = scheduleGateFixture({
      args: { name: "Daily" },
      neverAsk: true,
      storedEffects: legacyThenCanonical,
    });
    Object.assign(restoredWorker.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    for (const { fingerprint, occurrence } of legacyOrder.ctx.state.effects.occurrences as Array<{
      fingerprint: string;
      occurrence: number;
    }>) {
      restoredWorker.ctx.state.effects.counts.set(
        fingerprint,
        Math.max(restoredWorker.ctx.state.effects.counts.get(fingerprint) ?? 0, occurrence + 1),
      );
    }
    await expect(
      prepareToolRequest(restoredWorker.ctx as never, restoredWorker.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(restoredWorker.ctx as never, restoredWorker.request, undefined),
    ).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-canonical-second", name: "Daily" },
    });
  });

  it("replays selectorless and blank-selector schedule_list receipts in Never ask", async () => {
    useKeyedEffects();
    const ownListCompleted: StoredEffectRow = {
      id: "eff-own-list",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", {}),
      status: "completed",
      request: {},
      result: { routines: [{ id: "r-own-saved", name: "Own saved" }] },
    };
    const ownListRetry = scheduleGateFixture({
      name: "schedule_list",
      args: {},
      neverAsk: true,
      storedEffects: [ownListCompleted],
    });
    Object.assign(ownListRetry.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      prepareToolRequest(ownListRetry.ctx as never, ownListRetry.request),
    ).resolves.toBeUndefined();
    expect(await gateToolCall(ownListRetry.ctx as never, ownListRetry.request, undefined)).toEqual({
      replayed: true,
      result: { routines: [{ id: "r-own-saved", name: "Own saved" }] },
    });

    const blankListDenied: StoredEffectRow = {
      id: "eff-blank-list-denied",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", {
        bot_id: " ",
        bot_name: "",
      }),
      status: "denied",
      request: { bot_id: " ", bot_name: "" },
    };
    const blankListRetry = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: " ", bot_name: "" },
      neverAsk: true,
      storedEffects: [blankListDenied],
    });
    Object.assign(blankListRetry.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      prepareToolRequest(blankListRetry.ctx as never, blankListRetry.request),
    ).resolves.toBeUndefined();
    const blankOutcome = await gateToolCall(
      blankListRetry.ctx as never,
      blankListRetry.request,
      undefined,
    );
    expect("result" in blankOutcome).toBe(true);
    expect(blankOutcome).toMatchObject({ replayed: true });
  });

  it("replays an archived explicit-ID schedule_list without swallowing conflicting bot_id/bot_name errors", async () => {
    useKeyedEffects();
    const archivedCompletedList: StoredEffectRow = {
      id: "eff-list-archived-child",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", { bot_id: "child" }),
      status: "completed",
      request: { bot_id: "child", bot_name: "Child" },
      result: { routines: [{ id: "r-saved", name: "Saved routine" }] },
    };
    const archivedListRetry = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child" },
      neverAsk: true,
      storedEffects: [archivedCompletedList],
    });
    Object.assign(archivedListRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(archivedListRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(archivedListRetry.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(archivedListRetry.ctx as never, archivedListRetry.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(archivedListRetry.ctx as never, archivedListRetry.request, undefined),
    ).toEqual({
      replayed: true,
      result: { routines: [{ id: "r-saved", name: "Saved routine" }] },
    });

    const conflicting = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child", bot_name: "Someone Else" },
      neverAsk: true,
      storedEffects: [archivedCompletedList],
    });
    Object.assign(conflicting.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(conflicting.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(conflicting.ctx.trust, { receivedOutsideMessage: async () => false });
    const refused = await prepareToolRequest(conflicting.ctx as never, conflicting.request);
    expect(refused).toMatchObject({
      error: expect.stringMatching(/bot_id or bot_name, not both/i),
    });
  });

  it("does not let a name-only legacy receipt override an explicit child bot_id canonical receipt", async () => {
    useKeyedEffects();
    const legacyNamedOps: StoredEffectRow = {
      id: "eff-legacy-own-ops",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: "legacy-named-ops-1",
      status: "completed",
      request: { bot_name: "Ops", name: "Daily" },
      result: { ok: true, routineId: "r-old-own-ops", name: "Daily" },
    };
    const childCanonical: StoredEffectRow = {
      id: "eff-child-canonical",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        bot_id: "child",
        name: "Daily",
      }),
      status: "completed",
      request: { bot_id: "child", bot_name: "Ops", routineId: "r-child-real", name: "Daily" },
      result: { ok: true, routineId: "r-child-real", name: "Daily" },
    };
    const retryById = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily" },
      neverAsk: true,
      storedEffects: [legacyNamedOps, childCanonical],
    });
    Object.assign(retryById.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Ops", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(retryById.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(retryById.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(retryById.ctx as never, retryById.request),
    ).resolves.toBeUndefined();
    expect(await gateToolCall(retryById.ctx as never, retryById.request, undefined)).toEqual({
      replayed: true,
      result: { ok: true, routineId: "r-child-real", name: "Daily" },
    });
  });

  it("replays a base-release managed schedule_list with blank bot_name when retried by old name after rename", async () => {
    useKeyedEffects();
    const blankNameListReceipt: StoredEffectRow = {
      id: "eff-list-blank-bot-name",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", {
        bot_id: "child",
        bot_name: "Old Child",
      }),
      status: "completed",
      request: { bot_id: "child", bot_name: " " },
      result: { routines: [{ id: "r-old-child", name: "Old child routine" }] },
    };
    const retryByOldName = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_name: "Old Child" },
      neverAsk: true,
      storedEffects: [blankNameListReceipt],
    });
    Object.assign(retryByOldName.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [
          { id: "child", name: "Renamed Child", thread: { id: "c-t" } },
        ]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(retryByOldName.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(retryByOldName.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(retryByOldName.ctx as never, retryByOldName.request),
    ).resolves.toBeUndefined();
    expect(
      await gateToolCall(retryByOldName.ctx as never, retryByOldName.request, undefined),
    ).toEqual({
      replayed: true,
      result: { routines: [{ id: "r-old-child", name: "Old child routine" }] },
    });
  });

  it("replays an older blank-selector schedule_list denial on a named-self retry before newer receipts", async () => {
    useKeyedEffects();
    const blankDenial: StoredEffectRow = {
      id: "eff-list-blank-denial",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", {
        bot_id: " ",
        bot_name: "",
      }),
      status: "denied",
      request: { bot_id: " ", bot_name: "" },
    };
    const newerNamedList: StoredEffectRow = {
      id: "eff-list-named-self",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_list", {}),
      status: "completed",
      request: { bot_id: "bot-1", bot_name: "Helper" },
      result: { routines: [{ id: "r-newer", name: "Newer" }] },
    };

    for (const storedEffects of [[blankDenial], [blankDenial, newerNamedList]]) {
      const retry = scheduleGateFixture({
        name: "schedule_list",
        args: { bot_name: "Helper" },
        neverAsk: true,
        storedEffects,
      });
      Object.assign(retry.ctx.deps.prisma, {
        bot: {
          findUnique: vi.fn(async () => ({ fleetManagement: true })),
          findMany: vi.fn(async () => [{ id: "bot-1", name: "Helper", thread: { id: "t-1" } }]),
        },
        steeringMessage: { findFirst: vi.fn(async () => null) },
      });
      Object.assign(retry.ctx, {
        fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      });
      Object.assign(retry.ctx.trust, { receivedOutsideMessage: async () => false });
      await expect(prepareToolRequest(retry.ctx as never, retry.request)).resolves.toBeUndefined();
      const outcome = await gateToolCall(retry.ctx as never, retry.request, undefined);
      expect(outcome).toMatchObject({ replayed: true, result: { error: expect.any(String) } });
    }
  });

  it("ignores an already-consumed bare provider ID on a later distinct cancellation in the same run", async () => {
    useKeyedEffects();
    const consumedBareLegacy: StoredEffectRow = {
      id: "eff-bare-pi-legacy",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: "call-1",
      status: "completed",
      request: { name: "First" },
      result: { ok: true, routineId: "r-first", name: "First" },
    };
    const distinctCancel = scheduleGateFixture({
      args: { name: "Second" },
      neverAsk: true,
      storedEffects: [consumedBareLegacy],
    });
    distinctCancel.ctx.state.effects.consumedIds.add("eff-bare-pi-legacy");
    distinctCancel.ctx.state.effects.counts.set("call-1", 1);
    Object.assign(distinctCancel.ctx.deps.prisma, {
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      prepareToolRequest(distinctCancel.ctx as never, distinctCancel.request),
    ).resolves.toBeUndefined();
    const outcome = await gateToolCall(
      distinctCancel.ctx as never,
      distinctCancel.request,
      undefined,
    );
    expect("call" in outcome).toBe(true);
  });

  it("refuses an archived explicit-ID pinned intended cancellation instead of asking for approval", async () => {
    useKeyedEffects();
    const pinnedIntended: StoredEffectRow = {
      id: "eff-archived-intended",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "schedule_cancel", {
        bot_id: "child",
        name: "Daily",
      }),
      status: "intended",
      request: { bot_id: "child", bot_name: "Child", routineId: "r-daily", name: "Daily" },
    };
    const retry = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily" },
      heldForApproval: true,
      storedEffects: [pinnedIntended],
    });
    Object.assign(retry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(retry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(retry.ctx.trust, { receivedOutsideMessage: async () => false });
    const refused = await prepareToolRequest(retry.ctx as never, retry.request);
    expect(refused).toMatchObject({ error: expect.stringMatching(/no bot with id/i) });
  });

  it("refuses name-based and checkpointed pinned intended cancellations after the target bot is archived", async () => {
    useKeyedEffects();
    const key = toolEffectIdempotencyKey("run-1", "schedule_cancel", {
      bot_id: "child",
      name: "Daily",
    });
    const pinnedIntended: StoredEffectRow = {
      id: "eff-archived-intended-paths",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: key,
      status: "intended",
      request: { bot_id: "child", bot_name: "Child", routineId: "r-daily", name: "Daily" },
    };

    const namedRetry = scheduleGateFixture({
      args: { bot_name: "Child", name: "Daily" },
      heldForApproval: true,
      storedEffects: [pinnedIntended],
    });
    Object.assign(namedRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(namedRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(namedRetry.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(namedRetry.ctx as never, namedRetry.request),
    ).resolves.toMatchObject({ error: expect.stringMatching(/no bot with id/i) });

    const checkpointedRetry = scheduleGateFixture({
      args: { bot_id: "child", name: "Daily" },
      heldForApproval: true,
      storedEffects: [pinnedIntended],
    });
    Object.assign(checkpointedRetry.ctx.state.effects, {
      restoredPending: {
        executionId: checkpointedRetry.request.executionId,
        fingerprint: key,
        occurrence: 0,
      },
    });
    Object.assign(checkpointedRetry.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => []),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(checkpointedRetry.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(checkpointedRetry.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(checkpointedRetry.ctx as never, checkpointedRetry.request),
    ).resolves.toMatchObject({ error: expect.stringMatching(/no bot with id/i) });
  });

  it("validates and pins before-values when retrying an unpinned intended schedule_update in Ask", async () => {
    useKeyedEffects();
    const updateKey = toolEffectIdempotencyKey("run-1", "schedule_update", {
      bot_id: "child",
      routineId: "r-daily",
      prompt: "New prompt",
    });
    const unpinnedUpdate: StoredEffectRow = {
      id: "eff-intended-update",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_update",
      idempotencyKey: updateKey,
      status: "intended",
      request: {
        bot_id: "child",
        bot_name: "Child",
        routineId: "r-daily",
        prompt: "New prompt",
      },
    };

    // Deleted routine: settles the old intended receipt with a refusal instead of posting a card.
    const missingRoutine = scheduleGateFixture({
      name: "schedule_update",
      args: { bot_id: "child", routineId: "r-daily", prompt: "New prompt" },
      heldForApproval: true,
      storedEffects: [unpinnedUpdate],
    });
    Object.assign(missingRoutine.ctx.deps.prisma, {
      attempt: { count: vi.fn(async () => 1) },
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: {
        findFirst: vi.fn(async () => null),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(missingRoutine.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      secrets: [],
    });
    Object.assign(missingRoutine.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(missingRoutine.ctx as never, missingRoutine.request),
    ).resolves.toBeUndefined();
    const deletedOutcome = await gateToolCall(
      missingRoutine.ctx as never,
      missingRoutine.request,
      undefined,
    );
    expect(deletedOutcome).toMatchObject({
      result: { error: expect.stringMatching(/not found/i) },
    });

    // Existing routine: persists expected before-values onto the intended row before asking.
    const liveRoutine = scheduleGateFixture({
      name: "schedule_update",
      args: { bot_id: "child", routineId: "r-daily", prompt: "New prompt" },
      heldForApproval: true,
      storedEffects: [unpinnedUpdate],
    });
    Object.assign(liveRoutine.ctx.deps.prisma, {
      attempt: { count: vi.fn(async () => 1) },
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: {
        findFirst: vi.fn(async () => ({
          id: "r-daily",
          name: "Daily",
          prompt: "Old prompt",
          crons: ["0 9 * * *"],
          timezone: "UTC",
          inChat: false,
          active: true,
          watch: null,
          eventTriggers: null,
          userId: "user-1",
          botId: "child",
          threadId: "c-t",
          spaceId: "space-1",
        })),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(liveRoutine.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      secrets: [],
    });
    Object.assign(liveRoutine.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(liveRoutine.ctx as never, liveRoutine.request),
    ).resolves.toBeUndefined();
    await gateToolCall(liveRoutine.ctx as never, liveRoutine.request, undefined);
    expect(liveRoutine.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-intended-update", status: "intended" },
      data: {
        request: expect.objectContaining({
          routineId: "r-daily",
          prompt: "New prompt",
          expected: { prompt: "Old prompt" },
        }),
      },
    });
  });

  it("fences intended schedule_update baseline writes and refusals against a superseded worker", async () => {
    useKeyedEffects();
    const updateKey = toolEffectIdempotencyKey("run-1", "schedule_update", {
      bot_id: "child",
      routineId: "r-daily",
      prompt: "New prompt",
    });
    const unpinnedUpdate: StoredEffectRow = {
      id: "eff-fenced-update",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_update",
      idempotencyKey: updateKey,
      status: "intended",
      request: {
        bot_id: "child",
        bot_name: "Child",
        routineId: "r-daily",
        prompt: "New prompt",
      },
    };
    const makeSuperseded = (routineRow: unknown) => {
      const f = scheduleGateFixture({
        name: "schedule_update",
        args: { bot_id: "child", routineId: "r-daily", prompt: "New prompt" },
        heldForApproval: true,
        storedEffects: [unpinnedUpdate],
      });
      const txUpdateMany = vi.fn(async () => ({ count: 1 }));
      const tx = {
        $queryRaw: vi.fn(async () => []),
        run: {
          findUnique: vi.fn(async () => ({
            status: "waiting_input",
            leaseOwner: "worker-b",
            leaseFence: 2,
          })),
        },
        externalEffect: { updateMany: txUpdateMany },
      };
      Object.assign(f.ctx.deps, {
        runLease: { runId: "run-1", owner: "worker-a", fence: 1 },
      });
      Object.assign(f.ctx.deps.prisma, {
        $transaction: vi.fn(async (write: (client: typeof tx) => unknown) => write(tx)),
        attempt: { count: vi.fn(async () => 1) },
        bot: {
          findUnique: vi.fn(async () => ({ fleetManagement: true })),
          findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
        },
        routine: { findFirst: vi.fn(async () => routineRow) },
        run: { findUnique: vi.fn(async () => ({ status: "running" })) },
        steeringMessage: { findFirst: vi.fn(async () => null) },
      });
      Object.assign(f.ctx, {
        fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
        secrets: [],
      });
      Object.assign(f.ctx.trust, { receivedOutsideMessage: async () => false });
      return { ...f, txUpdateMany };
    };

    const baselineWrite = makeSuperseded({
      id: "r-daily",
      name: "Daily",
      prompt: "Old prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      inChat: false,
      active: true,
      watch: null,
      eventTriggers: null,
      userId: "user-1",
      botId: "child",
      threadId: "c-t",
      spaceId: "space-1",
    });
    await expect(
      prepareToolRequest(baselineWrite.ctx as never, baselineWrite.request),
    ).resolves.toBeUndefined();
    await expect(
      gateToolCall(baselineWrite.ctx as never, baselineWrite.request, undefined),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(baselineWrite.txUpdateMany).not.toHaveBeenCalled();

    const refusalWrite = makeSuperseded(null);
    await expect(
      prepareToolRequest(refusalWrite.ctx as never, refusalWrite.request),
    ).resolves.toBeUndefined();
    await expect(
      gateToolCall(refusalWrite.ctx as never, refusalWrite.request, undefined),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(refusalWrite.txUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a recovered schedule_update whose stored baseline drifted instead of showing a mismatched preview", async () => {
    useKeyedEffects();
    const updateKey = approvalEffectKey("run-1", "schedule_update", {
      bot_id: "child",
      routineId: "r-daily",
      prompt: "Prompt C",
    });
    const pinnedUpdate: StoredEffectRow = {
      id: "eff-drifted-update",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_update",
      idempotencyKey: updateKey,
      status: "intended",
      request: {
        bot_id: "child",
        bot_name: "Child",
        routineId: "r-daily",
        prompt: "Prompt C",
        expected: { prompt: "Prompt A" },
      },
    };
    const drifted = scheduleGateFixture({
      name: "schedule_update",
      args: { bot_id: "child", routineId: "r-daily", prompt: "Prompt C" },
      heldForApproval: true,
      storedEffects: [pinnedUpdate],
    });
    Object.assign(drifted.ctx.deps.prisma, {
      attempt: { count: vi.fn(async () => 1) },
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: {
        findFirst: vi.fn(async () => ({
          id: "r-daily",
          name: "Daily",
          prompt: "Prompt B",
          crons: ["0 9 * * *"],
          timezone: "UTC",
          inChat: false,
          active: true,
          watch: null,
          eventTriggers: null,
          userId: "user-1",
          botId: "child",
          threadId: "c-t",
          spaceId: "space-1",
        })),
      },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(drifted.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      secrets: [],
    });
    Object.assign(drifted.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(drifted.ctx as never, drifted.request),
    ).resolves.toBeUndefined();
    const outcome = await gateToolCall(drifted.ctx as never, drifted.request, undefined);
    expect(outcome).toMatchObject({
      result: { error: expect.stringMatching(/schedule changed while saving/i) },
    });
    expect(drifted.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-drifted-update", status: "intended" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(drifted.ctx.state.effects.consumedIds.has("eff-drifted-update")).toBe(true);
    expect(drifted.ctx.state.effects.counts.get(updateKey)).toBe(1);
  });

  it("validates and settles a recovered pinned intended schedule_cancel when its routine was deleted", async () => {
    useKeyedEffects();
    const cancelKey = approvalEffectKey("run-1", "schedule_cancel", {
      bot_id: "child",
      name: "Daily",
    });
    const pinnedCancel: StoredEffectRow = {
      id: "eff-deleted-cancel",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: cancelKey,
      status: "intended",
      request: {
        bot_id: "child",
        bot_name: "Child",
        routineId: "r-daily",
        name: "Daily",
      },
    };
    const deleted = scheduleGateFixture({
      name: "schedule_cancel",
      args: { bot_id: "child", name: "Daily" },
      heldForApproval: true,
      storedEffects: [pinnedCancel],
    });
    const findFirst = vi.fn(async () => null);
    Object.assign(deleted.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: { findFirst },
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(deleted.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(deleted.ctx.trust, { receivedOutsideMessage: async () => false });

    await expect(
      prepareToolRequest(deleted.ctx as never, deleted.request),
    ).resolves.toBeUndefined();
    const outcome = await gateToolCall(deleted.ctx as never, deleted.request, undefined);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "r-daily" }) }),
    );
    expect(outcome).toEqual({ result: { error: "Schedule not found." } });
    expect(deleted.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-deleted-cancel", status: "intended" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(deleted.ctx.state.effects.consumedIds.has("eff-deleted-cancel")).toBe(true);
  });

  it("consumes an archived bot's intended receipt so a later call by the reused name resolves the active bot", async () => {
    useKeyedEffects();
    const archivedKey = approvalEffectKey("run-1", "schedule_cancel", {
      bot_id: "child-old",
      name: "Daily",
    });
    const archivedReceipt: StoredEffectRow = {
      id: "eff-archived-shadow",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_cancel",
      idempotencyKey: archivedKey,
      status: "intended",
      request: {
        bot_id: "child-old",
        bot_name: "Child",
        routineId: "r-old",
        name: "Daily",
      },
    };
    const first = scheduleGateFixture({
      name: "schedule_cancel",
      args: { bot_name: "Child", name: "Daily" },
      heldForApproval: true,
      storedEffects: [archivedReceipt],
    });
    const findBot = vi.fn(async (query?: { where?: { id?: string; name?: string } }) => {
      if (query?.where?.id === "child-old") return [];
      return [{ id: "child-new", name: "Child", thread: { id: "n-t" } }];
    });
    Object.assign(first.ctx.deps.prisma, {
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: findBot,
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(first.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(first.ctx.trust, { receivedOutsideMessage: async () => false });

    const firstRefused = await prepareToolRequest(first.ctx as never, first.request);
    expect(firstRefused).toMatchObject({ error: expect.stringMatching(/no bot with id/i) });
    expect(first.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "eff-archived-shadow", status: "intended" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(first.ctx.state.effects.consumedIds.has("eff-archived-shadow")).toBe(true);

    const secondExecutionId = JSON.stringify(["pi-tool", "main", "call-2"]);
    const secondRequest = {
      ...first.request,
      args: { bot_name: "Child", name: "Daily" },
      executionId: secondExecutionId,
      connectorCall: {
        tool: "schedule_cancel",
        args: { bot_name: "Child", name: "Daily" },
        executionId: secondExecutionId,
        route: undefined,
      },
      effectRequest: { bot_name: "Child", name: "Daily" },
      effectKeyArgs: undefined,
      reconciledEffectKey: undefined,
    } as unknown as ToolRequest;
    await expect(prepareToolRequest(first.ctx as never, secondRequest)).resolves.toBeUndefined();
    expect(secondRequest.args).toEqual({
      bot_id: "child-new",
      bot_name: "Child",
      name: "Daily",
    });
  });

  it("fences unpinned legacy managed-routine refusals and replays when the transition loses", async () => {
    useKeyedEffects();
    const key = approvalEffectKey("run-1", "schedule_list", { bot_id: "child" });
    const unpinned: StoredEffectRow = {
      id: "eff-legacy-bot-fence",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_list",
      idempotencyKey: key,
      status: "intended",
      request: { bot_name: "Child" },
    };

    // Superseded worker throws before writing to externalEffect.
    const superseded = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child", bot_name: "Child" },
      effectKeyArgs: { bot_id: "child" },
      heldForApproval: true,
      storedEffects: [unpinned],
    });
    const txUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({
          status: "running",
          leaseOwner: "worker-b",
          leaseFence: 2,
        })),
      },
      externalEffect: { updateMany: txUpdateMany },
    };
    Object.assign(superseded.ctx.deps, {
      runLease: { runId: "run-1", owner: "worker-a", fence: 1 },
    });
    Object.assign(superseded.ctx.deps.prisma, {
      $transaction: vi.fn(async (write: (client: typeof tx) => unknown) => write(tx)),
    });
    await expect(
      gateToolCall(superseded.ctx as never, superseded.request, undefined),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(txUpdateMany).not.toHaveBeenCalled();

    // Losing transition re-reads the effect and replays the completed result.
    const row: StoredEffectRow = { ...unpinned };
    const losing = scheduleGateFixture({
      name: "schedule_list",
      args: { bot_id: "child", bot_name: "Child" },
      effectKeyArgs: { bot_id: "child" },
      heldForApproval: true,
      storedEffects: [row],
    });
    losing.effectUpdateMany.mockImplementationOnce(async () => {
      row.status = "completed";
      row.result = { routines: [{ id: "r-settled" }] };
      return { count: 0 };
    });
    await expect(gateToolCall(losing.ctx as never, losing.request, undefined)).resolves.toEqual({
      replayed: true,
      result: { routines: [{ id: "r-settled" }] },
    });
  });

  it("passes the persisted schedule_update baseline to the handler when Auto pass or Never ask executes", async () => {
    useKeyedEffects();
    const updateKey = approvalEffectKey("run-1", "schedule_update", {
      bot_id: "child",
      routineId: "r-daily",
      prompt: "Prompt C",
    });

    // Stored Auto pass: preview validates Prompt A, then call.args keeps expected.prompt = Prompt A
    // so an edit to Prompt B before the save conflicts instead of overwriting Prompt B.
    const autoPassedRow: StoredEffectRow & { reviewDecision?: string } = {
      id: "eff-auto-pass-update",
      runId: "run-1",
      spaceId: "space-1",
      kind: "schedule_update",
      idempotencyKey: updateKey,
      status: "intended",
      reviewDecision: "pass",
      request: {
        bot_id: "child",
        bot_name: "Child",
        routineId: "r-daily",
        prompt: "Prompt C",
        expected: { prompt: "Prompt A" },
      },
    };
    const autoFixture = scheduleGateFixture({
      name: "schedule_update",
      args: { bot_id: "child", routineId: "r-daily", prompt: "Prompt C" },
      storedEffects: [autoPassedRow],
    });
    let livePrompt = "Prompt A";
    Object.assign(autoFixture.ctx.deps, {
      autoReview: vi.fn(async () => ({ decision: "ask", reason: "should not re-judge" })),
    });
    Object.assign(autoFixture.ctx.deps.prisma, {
      attempt: { count: vi.fn(async () => 1) },
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      routine: {
        findFirst: vi.fn(async () => ({
          id: "r-daily",
          name: "Daily",
          prompt: livePrompt,
          crons: ["0 9 * * *"],
          timezone: "UTC",
          inChat: false,
          active: true,
          watch: null,
          eventTriggers: null,
          userId: "user-1",
          botId: "child",
          threadId: "c-t",
          spaceId: "space-1",
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      run: { findUnique: vi.fn(async () => ({ status: "running" })) },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(autoFixture.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      secrets: [],
    });
    Object.assign(autoFixture.ctx.trust, {
      receivedOutsideMessage: async () => false,
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
    });

    await expect(
      prepareToolRequest(autoFixture.ctx as never, autoFixture.request),
    ).resolves.toBeUndefined();
    const autoOutcome = await gateToolCall(
      autoFixture.ctx as never,
      autoFixture.request,
      undefined,
    );
    expect("call" in autoOutcome).toBe(true);
    if (!("call" in autoOutcome)) throw new Error("expected auto-passed schedule_update call");
    expect(autoOutcome.call.args).toMatchObject({
      routineId: "r-daily",
      prompt: "Prompt C",
      expected: { prompt: "Prompt A" },
    });
    // Owner edits the routine after preview: save handler refuses via the pinned baseline.
    livePrompt = "Prompt B";
    await expect(
      taskTools.schedule_update!(autoFixture.ctx as never, autoOutcome.call),
    ).resolves.toEqual({
      error: "The schedule changed while saving. Call schedule_list and try again.",
    });

    // Policy switched to Never ask: stored expected baseline still reaches the save handler.
    const neverAskFixture = scheduleGateFixture({
      name: "schedule_update",
      args: { bot_id: "child", routineId: "r-daily", prompt: "Prompt C" },
      neverAsk: true,
      storedEffects: [autoPassedRow],
    });
    Object.assign(neverAskFixture.ctx.deps.prisma, {
      attempt: { count: vi.fn(async () => 1) },
      bot: {
        findUnique: vi.fn(async () => ({ fleetManagement: true })),
        findMany: vi.fn(async () => [{ id: "child", name: "Child", thread: { id: "c-t" } }]),
      },
      steeringMessage: { findFirst: vi.fn(async () => null) },
    });
    Object.assign(neverAskFixture.ctx, {
      fleetRun: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
    });
    Object.assign(neverAskFixture.ctx.trust, { receivedOutsideMessage: async () => false });
    await expect(
      prepareToolRequest(neverAskFixture.ctx as never, neverAskFixture.request),
    ).resolves.toBeUndefined();
    const neverAskOutcome = await gateToolCall(
      neverAskFixture.ctx as never,
      neverAskFixture.request,
      undefined,
    );
    expect("call" in neverAskOutcome).toBe(true);
    if (!("call" in neverAskOutcome)) throw new Error("expected never-ask schedule_update call");
    expect(neverAskOutcome.call.args).toMatchObject({
      routineId: "r-daily",
      prompt: "Prompt C",
      expected: { prompt: "Prompt A" },
    });
  });
});
