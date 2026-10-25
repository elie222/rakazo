import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_AUTONOMY_MAX_ROUNDS,
  localGroupReviewConfig,
  scheduleLocalGroupReview,
} from "./local-group-review.js";

type Kind = "root" | "peer" | "auto" | "deep-peer";
function harness(
  kind: Kind = "root",
  opts: {
    delegated?: boolean;
    newerUser?: boolean;
    groupMembers?: number;
    ageMs?: number;
    round?: number;
    ineligibleSource?: boolean;
  } = {},
) {
  const createdAt = new Date(Date.now() - (opts.ageMs ?? 1_000));
  const originalMessage = {
    id: "original-message",
    role: "user",
    runId: "root",
    blocks: [{ kind: "text", text: "Review dividend sustainability." }],
  };
  const handoffMessage = {
    role: "bot",
    runId: "root",
    blocks: [
      {
        kind: "handoff",
        text: "Critique the analysis",
        fromBotId: "owner",
        toBotId: "critic",
        hop: 1,
      },
    ],
  };
  const deeperHandoff = {
    role: "bot",
    runId: "auto-run",
    blocks: [
      {
        kind: "handoff",
        text: "Explore an alternative",
        fromBotId: "owner",
        toBotId: "critic",
        hop: 1,
      },
    ],
  };
  const root = {
    id: "root",
    botId: "owner",
    userId: "user",
    spaceId: "space",
    threadId: "thread",
    createdAt,
    sourceMessageId: "original-message",
    sourceMessage: originalMessage,
    trigger: "follow_up",
    clientNonce: null,
  };
  const autoRun = {
    ...root,
    id: "auto-run",
    clientNonce: `local-agent-goal:root:${opts.round ?? 1}`,
  };
  const completed = {
    ...root,
    id: kind === "root" ? "root" : kind === "auto" ? "auto-run" : "finished",
    botId: kind === "root" || kind === "auto" ? "owner" : "critic",
    sourceMessage:
      kind === "root" || kind === "auto"
        ? originalMessage
        : kind === "deep-peer"
          ? deeperHandoff
          : handoffMessage,
    sourceMessageId: kind === "root" || kind === "auto" ? "original-message" : "handoff-msg",
    clientNonce: kind === "auto" ? `local-agent-goal:root:${opts.round ?? 1}` : null,
    status: "completed",
    groupReviewScheduledAt: null as Date | null,
    thread: { groupId: "group" },
  };
  const creates: Array<unknown> = [];
  const mark = vi.fn(async (arg: { data: { groupReviewScheduledAt: Date } }) => {
    completed.groupReviewScheduledAt = arg.data.groupReviewScheduledAt;
    return completed;
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: completed.id }]),
    run: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === completed.id) return completed;
        if (args.where.id === "root") return root;
        if (args.where.id === "auto-run") return autoRun;
        return null;
      }),
      update: mark,
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (input: unknown) => {
        creates.push(input);
        return { id: "new-run" };
      }),
    },
    message: { findFirst: vi.fn(async () => (opts.newerUser ? { id: "new-msg" } : null)) },
    event: { findFirst: vi.fn(async () => (opts.delegated ? { id: "handoff" } : null)) },
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group",
        members: Array.from({ length: opts.groupMembers ?? 2 }, (_, i) => ({ botId: `bot${i}` })),
      })),
    },
    task: { create: vi.fn(async () => ({ id: "task" })) },
  };
  if (opts.ineligibleSource) completed.sourceMessageId = "";
  const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  const jobs = { enqueue: vi.fn(async () => {}) };
  return {
    deps: { prisma, jobs, events: { notify: vi.fn() } },
    completed,
    mark,
    creates,
    tx,
    jobs,
  };
}

describe("bounded local goal orchestration", () => {
  it("requires explicit enablement plus a rollout timestamp", () => {
    expect(localGroupReviewConfig({ RAKAZO_GROUP_REVIEW_ENABLED: "true" }).enabled).toBe(false);
    expect(
      localGroupReviewConfig({
        RAKAZO_GROUP_REVIEW_ENABLED: "true",
        RAKAZO_GROUP_REVIEW_SINCE: "2026-10-25T14:00:00Z",
      }).enabled,
    ).toBe(true);
  });
  it("starts an internal goal evaluation after a completed user request even without handoff", async () => {
    const h = harness("root");
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({
      scheduled: true,
      runId: "new-run",
    });
    expect(h.creates).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "owner",
          trigger: "follow_up",
          clientNonce: "local-agent-goal:root:1",
          sourceMessageId: "original-message",
        }),
      }),
    ]);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(h.completed.groupReviewScheduledAt).toBeInstanceOf(Date);
    // Idempotent across reconciler restarts.
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({ scheduled: false });
    expect(h.creates).toHaveLength(1);
  });
  it("awaits a delegated specialist rather than overlapping its work", async () => {
    const h = harness("root", { delegated: true });
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({ scheduled: false });
    expect(h.creates).toHaveLength(0);
    expect(h.mark).toHaveBeenCalledTimes(1);
  });
  it("resumes the goal after a specialist's first handoff", async () => {
    const h = harness("peer");
    expect(await scheduleLocalGroupReview(h.deps as never, "finished")).toMatchObject({
      scheduled: true,
    });
    expect(h.creates[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "local-agent-goal:root:1" }),
      }),
    );
  });
  it("can deepen after a subsequent delegated round", async () => {
    const h = harness("deep-peer", { round: 1 });
    expect(await scheduleLocalGroupReview(h.deps as never, "finished")).toMatchObject({
      scheduled: true,
    });
    expect(h.creates[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "local-agent-goal:root:2" }),
      }),
    );
  });
  it("stops when its internal assessment needs no further specialist", async () => {
    const h = harness("auto", { round: 1 });
    expect(await scheduleLocalGroupReview(h.deps as never, "auto-run")).toEqual({
      scheduled: false,
    });
    expect(h.creates).toHaveLength(0);
  });
  it("stops when max autonomous rounds are exhausted", async () => {
    const h = harness("deep-peer", { round: LOCAL_AUTONOMY_MAX_ROUNDS });
    expect(await scheduleLocalGroupReview(h.deps as never, "finished")).toEqual({
      scheduled: false,
    });
    expect(h.creates).toHaveLength(0);
  });
  it("stops when newer user instructions supersede the goal", async () => {
    const h = harness("root", { newerUser: true });
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({ scheduled: false });
    expect(h.creates).toHaveLength(0);
  });
  it("stops work older than the bounded active goal window", async () => {
    const h = harness("root", { ageMs: 30 * 60_000 });
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({ scheduled: false });
  });
  it("does not autostart a one-bot group", async () => {
    const h = harness("root", { groupMembers: 1 });
    expect(await scheduleLocalGroupReview(h.deps as never, "root")).toEqual({ scheduled: false });
  });
});
