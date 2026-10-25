import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  advanceGroupTeam,
  chooseGroupTeammates,
  parsePeerJobNonce,
  peerJobNonce,
  requestedGroupParticipants,
} from "./local-group-dispatch.js";

const bots = [
  { id: "lead", name: "Coordinator", title: "Leader", description: "Plans work" },
  { id: "a", name: "Investigator", title: "Original sources", description: "Reads evidence" },
  { id: "b", name: "Critic", title: "Skeptic", description: "Tests claims" },
  { id: "c", name: "Fact Checker", title: "Auditor", description: "Checks claims" },
];
const root = {
  id: "root",
  botId: "lead",
  userId: "user",
  spaceId: "space",
  threadId: "thread",
  sourceMessageId: "message",
  sourceMessage: { role: "user" },
  createdAt: new Date(),
  trigger: "user",
  status: "completed",
  clientNonce: "send:root",
  groupReviewScheduledAt: null as Date | null,
  thread: { groupId: "group" },
};
function harness(
  opts: {
    peer?: boolean;
    statuses?: string[];
    active?: boolean;
    delegated?: boolean;
    superseded?: boolean;
    unrelatedGroup?: boolean;
    existingSynthesis?: boolean;
    count?: number;
    roster?: typeof bots;
    sourceBlocks?: unknown;
  } = {},
) {
  const members = opts.roster ?? bots.slice(0, opts.count ?? 4);
  const current = opts.peer
    ? {
        ...root,
        id: "peer1",
        botId: "a",
        trigger: "follow_up",
        clientNonce: peerJobNonce("root", "a"),
        status: opts.active ? "running" : "completed",
      }
    : { ...root };
  const created: { data: { clientNonce: string; botId: string; sourceMessageId: string } }[] = [];
  const marked: string[] = [];
  let nextId = 0;
  const tx = {
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "root"
          ? { ...root, sourceMessage: { role: "user", blocks: opts.sourceBlocks ?? [] } }
          : where.id === "peer1"
            ? current
            : null,
      ),
      findFirst: vi.fn(async ({ where }: { where: { clientNonce: string } }) =>
        opts.existingSynthesis && where.clientNonce === "local-agent-goal:root:1"
          ? { id: "already" }
          : null,
      ),
      findMany: vi.fn(async () =>
        (opts.statuses ?? []).map((status, i) => ({ id: `peer${i}`, status })),
      ),
      create: vi.fn(
        async (args: { data: { clientNonce: string; botId: string; sourceMessageId: string } }) => {
          created.push(args);
          return { id: `new-${++nextId}` };
        },
      ),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        marked.push(where.id);
      }),
    },
    chatGroup: {
      findUnique: vi.fn(async () => ({
        name: "株探索",
        archivedAt: null,
        members: members.map((bot) => ({ bot })),
      })),
    },
    event: { findFirst: vi.fn(async () => (opts.delegated ? { id: "handoff" } : null)) },
    message: { findFirst: vi.fn(async () => (opts.superseded ? { id: "later" } : null)) },
    task: { create: vi.fn(async () => ({ id: "task" })) },
    $queryRaw: vi.fn(async () => [{ id: "root" }]),
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  const jobs = { enqueue: vi.fn(async () => {}) };
  return { current, tx, created, marked, deps: { prisma, jobs }, jobs };
}

describe("generic, bounded group collaboration", () => {
  it("picks all other members by group membership, regardless of name or specialization", () => {
    expect(chooseGroupTeammates(bots, "lead").map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(parsePeerJobNonce(peerJobNonce("root", "b"))).toEqual({ rootId: "root", botId: "b" });
    expect(parsePeerJobNonce("user:some-run")).toBeNull();
  });
  it("selects named specialists without truncating the roster", () => {
    const roster = [
      ...bots,
      { id: "d", name: "DevOps", title: "Operations", description: "Deployment" },
    ];
    const requested = requestedGroupParticipants(
      [{ kind: "text", text: "Investigate @DevOps and @Critic, not @InvestigatorExtra." }],
      roster,
    );
    expect(requested).toEqual(["b", "d"]);
    expect(chooseGroupTeammates(roster, "lead", requested).map((bot) => bot.id)).toEqual([
      "b",
      "d",
    ]);
    expect(chooseGroupTeammates(roster, "lead").map((bot) => bot.id)).toEqual(["a", "b", "c", "d"]);
    // Mentioning only the coordinator does not accidentally trigger an all-member broadcast.
    expect(chooseGroupTeammates(roster, "lead", ["lead"])).toEqual([]);
  });
  it("does not impose a second limit on a group of ten agents", () => {
    const roster = Array.from({ length: 10 }, (_, i) => ({
      id: `bot${i}`,
      name: `Member ${i}`,
      title: "Analyst",
      description: "Research",
    }));
    expect(chooseGroupTeammates(roster, "bot0").map((bot) => bot.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `bot${i + 1}`),
    );
    const allExplicit = requestedGroupParticipants(
      [
        {
          kind: "text",
          text: roster
            .slice(1)
            .map((bot) => `@${bot.name}`)
            .join(" "),
        },
      ],
      roster,
    );
    expect(chooseGroupTeammates(roster, "bot0", allExplicit)).toHaveLength(9);
  });
  it("starts independent tasks for the peers after an ordinary user-triggered run", async () => {
    const h = harness();
    expect(await advanceGroupTeam(h.deps as never, "root")).toEqual({
      handled: true,
      stage: "team",
      scheduled: 3,
    });
    expect(h.created.map((c) => c.data.clientNonce)).toEqual(
      ["a", "b", "c"].map((id) => peerJobNonce("root", id)),
    );
    expect(h.created.every((c) => c.data.sourceMessageId === "message")).toBe(true);
    expect(h.marked).toEqual(["root"]);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(3);
    expect(h.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: expect.stringContaining('Group: "株探索"') }),
      }),
    );
  });
  it("schedules all nine peers in a ten-member group", async () => {
    const roster = [
      bots[0]!,
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `member${i}`,
        name: `Member ${i}`,
        title: "Researcher",
        description: "Review evidence",
      })),
    ];
    const h = harness({ roster });
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({
      handled: true,
      stage: "team",
      scheduled: 9,
    });
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(9);
    expect(h.created.map((item) => item.data.botId)).toEqual(roster.slice(1).map((bot) => bot.id));
  });
  it("honors an explicit selection during actual scheduling", async () => {
    const h = harness({
      sourceBlocks: [{ kind: "text", text: "Please ask @Critic to review this claim." }],
    });
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({
      stage: "team",
      scheduled: 1,
    });
    expect(h.created.map((item) => item.data.botId)).toEqual(["b"]);
  });
  it("works in 2-bot groups without professional titles", async () => {
    const h = harness({ count: 2 });
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({
      stage: "team",
      scheduled: 1,
    });
  });
  it("does not override the first agent's explicit handoff", async () => {
    const h = harness({ delegated: true });
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({ handled: false });
    expect(h.created).toHaveLength(0);
  });
  it("waits until ALL peer runs are terminal", async () => {
    const h = harness({ peer: true, statuses: ["completed", "running", "completed"] });
    expect(await advanceGroupTeam(h.deps as never, "peer1")).toMatchObject({
      handled: true,
      stage: "waiting",
      scheduled: 0,
    });
    expect(h.created).toHaveLength(0);
  });
  it("reliably schedules final owner synthesis after all peers finish", async () => {
    const h = harness({ peer: true, statuses: ["completed", "completed", "completed"] });
    expect(await advanceGroupTeam(h.deps as never, "peer1")).toMatchObject({
      handled: true,
      stage: "synthesis",
      scheduled: 1,
    });
    expect(h.created[0]?.data).toMatchObject({
      clientNonce: "local-agent-goal:root:1",
      botId: "lead",
    });
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
  });
  it("does not deadlock after one peer fails", async () => {
    const h = harness({ peer: true, statuses: ["completed", "failed", "completed"] });
    expect(await advanceGroupTeam(h.deps as never, "peer1")).toMatchObject({
      stage: "synthesis",
      scheduled: 1,
    });
  });
  it("does not duplicate already-scheduled synthesis", async () => {
    const h = harness({
      peer: true,
      statuses: ["completed", "completed", "completed"],
      existingSynthesis: true,
    });
    expect(await advanceGroupTeam(h.deps as never, "peer1")).toMatchObject({
      stage: "synthesis",
      scheduled: 0,
    });
    expect(h.created).toHaveLength(0);
  });
  it("stops obsolete work when the user issues a later message", async () => {
    const h = harness({ superseded: true });
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({
      stage: "superseded",
      scheduled: 0,
    });
    expect(h.created).toHaveLength(0);
  });
  it("does not initiate a second team fanout from a synthesis checkpoint", async () => {
    const h = harness();
    h.tx.run.findUnique.mockImplementation(async () => ({
      ...root,
      clientNonce: "local-agent-goal:root:1",
    }));
    expect(await advanceGroupTeam(h.deps as never, "root")).toMatchObject({ handled: false });
    expect(h.created).toHaveLength(0);
  });
});
