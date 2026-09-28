import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { IsolationError } from "./scope.js";

describe("listSpaceGroupsForSpaces", () => {
  it("loads and maps compact cross-space group fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Escalation pending" }] }],
        },
        members: [
          { bot: { id: "bot-1", name: "Triage", color: "#111", runs: [] } },
          {
            bot: {
              id: "bot-2",
              name: "Responder",
              color: "#222",
              runs: [{ status: "running" }],
            },
          },
        ],
      },
    ]);
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    };

    await expect(repos.listSpaceGroupsForSpaces(actor, ["workspace-2"])).resolves.toEqual([
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        members: [
          { botId: "bot-1", name: "Triage", color: "#111", status: "idle" },
          { botId: "bot-2", name: "Responder", color: "#222", status: "running" },
        ],
        preview: "Escalation pending",
        unread: true,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.select).not.toHaveProperty("userId");
    expect(query.select).not.toHaveProperty("archivedAt");
    expect(query.select).not.toHaveProperty("createdAt");
  });
});

describe("archiveGroup", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.com",
    isDeploymentOwner: true,
  };
  let queryRaw: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findManyRuns: ReturnType<typeof vi.fn>;
  let findManyComputers: ReturnType<typeof vi.fn>;
  let runUpdateMany: ReturnType<typeof vi.fn>;
  let attemptUpdateMany: ReturnType<typeof vi.fn>;
  let taskUpdateMany: ReturnType<typeof vi.fn>;
  let leaseUpdateMany: ReturnType<typeof vi.fn>;
  let leaseFindMany: ReturnType<typeof vi.fn>;
  let computerUpdateMany: ReturnType<typeof vi.fn>;
  let eventDeleteMany: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }]);
    findFirst = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findManyRuns = vi.fn().mockResolvedValue([
      { id: "run-1", taskId: "task-1" },
      { id: "run-legacy", taskId: "task-legacy" },
    ]);
    // computer-1 matches production: the lease is ownership, executionRunId stays unset.
    // computer-legacy is the executionRunId fallback for a run with no lease row.
    // computer-2's executionRunId names a reclaimed run; resume must not follow that column.
    const computerRows = [
      {
        id: "computer-1",
        homeKey: "home-1",
        kind: "fake",
        providerRef: "computer-1",
        executionBotId: null,
        executionRunId: null,
      },
      {
        id: "computer-2",
        homeKey: "home-2",
        kind: "fake",
        providerRef: "computer-2",
        executionBotId: "bot-4",
        executionRunId: "run-reclaimed",
      },
      {
        id: "computer-expired",
        homeKey: "home-expired",
        kind: "fake",
        providerRef: "computer-expired",
        executionBotId: null,
        executionRunId: null,
      },
      {
        id: "computer-legacy",
        homeKey: "home-legacy",
        kind: "fake",
        providerRef: "computer-legacy",
        executionBotId: "bot-legacy",
        executionRunId: "run-legacy",
      },
    ];
    type ComputerWhere = {
      id?: { in: string[] };
      executionRunId?: { in: string[] };
      OR?: ComputerWhere[];
    };
    const matches = (row: (typeof computerRows)[number], where: ComputerWhere): boolean =>
      (where.OR?.some((clause) => matches(row, clause)) ?? false) ||
      Boolean(where.id?.in.includes(row.id)) ||
      Boolean(row.executionRunId && where.executionRunId?.in.includes(row.executionRunId));
    findManyComputers = vi.fn(async ({ where }: { where: ComputerWhere }) =>
      computerRows.filter((row) => matches(row, where)),
    );
    runUpdateMany = vi.fn();
    attemptUpdateMany = vi.fn();
    taskUpdateMany = vi.fn();
    // computer-1 is a Team computer: bot-2's lease there belongs to a run outside this group.
    // run-1 and run-stale expired without reclaim, so their runId still names the screen.
    // run-reclaimed has no lease row; computer-2's column is not enough to resume.
    const liveUntil = new Date("2099-01-01T00:00:00.000Z");
    // After the cleanup epoch, so a resume still tears this unreclaimed lease down.
    const expiredAt = new Date("2026-09-25T00:00:00.000Z");
    const leaseRows = [
      { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3, expiresAt: liveUntil },
      {
        computerId: "computer-expired",
        botId: "bot-1",
        runId: "run-1",
        fence: 9,
        expiresAt: expiredAt,
      },
      {
        computerId: "computer-1",
        botId: "bot-2",
        runId: "run-other",
        fence: 7,
        expiresAt: liveUntil,
      },
      {
        computerId: "computer-2",
        botId: "bot-3",
        runId: "run-other-group",
        fence: 1,
        expiresAt: liveUntil,
      },
      {
        computerId: "computer-2",
        botId: "bot-4",
        runId: "run-stale",
        fence: 2,
        expiresAt: expiredAt,
      },
    ];
    leaseUpdateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { runId?: { in: string[] } };
        data: { expiresAt?: Date };
      }) => {
        if (!where.runId || !data.expiresAt) return;
        for (const lease of leaseRows) {
          if (where.runId.in.includes(lease.runId)) lease.expiresAt = data.expiresAt;
        }
      },
    );
    type LeaseWhere = { runId: { in: string[] }; expiresAt?: { gt: Date } };
    leaseFindMany = vi.fn(async ({ where }: { where: LeaseWhere }) =>
      leaseRows.filter((lease) => {
        if (!where.runId.in.includes(lease.runId)) return false;
        return !where.expiresAt || lease.expiresAt > where.expiresAt.gt;
      }),
    );
    computerUpdateMany = vi.fn();
    eventDeleteMany = vi.fn();
    groupUpdate = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      chatGroup: { findFirst, update: groupUpdate },
      run: { findMany: findManyRuns, updateMany: runUpdateMany },
      attempt: { updateMany: attemptUpdateMany },
      task: { updateMany: taskUpdateMany },
      computerExecutionLease: { findMany: leaseFindMany, updateMany: leaseUpdateMany },
      computer: { findMany: findManyComputers, updateMany: computerUpdateMany },
      event: { deleteMany: eventDeleteMany },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: { updateMany: leaseUpdateMany },
      computer: { updateMany: computerUpdateMany },
    } as unknown as PrismaClient;
  });

  it("tears down only this thread's runs, each under its own lease", async () => {
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).resolves.toEqual({
      cancelledRunIds: ["run-1", "run-legacy"],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 3,
        },
        {
          id: "computer-expired",
          homeKey: "home-expired",
          kind: "fake",
          providerRef: "computer-expired",
          botId: "bot-1",
          runId: "run-1",
          fence: 9,
        },
        {
          id: "computer-legacy",
          homeKey: "home-legacy",
          kind: "fake",
          providerRef: "computer-legacy",
          botId: "bot-legacy",
          runId: "run-legacy",
          fence: 0,
        },
      ],
    });
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: { in: ["run-1", "run-legacy"] } },
      }),
    );

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "group-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        select: { archivedAt: true, thread: { select: { id: true } } },
      }),
    );
    // The leases outlive the transaction so the caller's screen release still carries the fence.
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(computerUpdateMany).not.toHaveBeenCalled();
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: expect.objectContaining({ pinned: false, archivedAt: expect.any(Date) }),
    });
  });

  it("expires the archived runs' leases and legacy columns once teardown is done", async () => {
    const expire = vi.fn();
    const clear = vi.fn();
    const repos = createGroupRepos({
      computerExecutionLease: { updateMany: expire },
      computer: { updateMany: clear },
    } as unknown as PrismaClient);

    await repos.releaseArchivedRunLeases([]);
    expect(expire).not.toHaveBeenCalled();
    await repos.releaseArchivedRunLeases(["run-1"]);
    expect(expire).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(clear).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  });

  it("resumes teardown for cancelled runs whose lease row still names them", async () => {
    const archivedAt = new Date("2026-09-26T00:00:00.000Z");
    findFirst.mockResolvedValue({ archivedAt, thread: { id: "thread-1" } });
    findManyRuns.mockResolvedValue([{ id: "run-1" }, { id: "run-stale" }, { id: "run-reclaimed" }]);
    const repos = createGroupRepos(prisma);

    const archived = await repos.archiveGroup(actor, "group-1");
    expect(archived).toEqual({
      cancelledRunIds: ["run-1", "run-stale"],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 3,
        },
        {
          id: "computer-expired",
          homeKey: "home-expired",
          kind: "fake",
          providerRef: "computer-expired",
          botId: "bot-1",
          runId: "run-1",
          fence: 9,
        },
        {
          id: "computer-2",
          homeKey: "home-2",
          kind: "fake",
          providerRef: "computer-2",
          botId: "bot-4",
          runId: "run-stale",
          fence: 2,
        },
      ],
    });

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith({
      where: { threadId: "thread-1", status: "cancelled" },
      select: { id: true },
    });
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId: { in: ["run-1", "run-stale", "run-reclaimed"] },
          expiresAt: { gt: new Date(0) },
        },
      }),
    );
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(runUpdateMany).not.toHaveBeenCalled();
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(computerUpdateMany).not.toHaveBeenCalled();

    await repos.releaseArchivedRunLeases(archived.cancelledRunIds);
    expect(leaseUpdateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1", "run-stale"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(computerUpdateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1", "run-stale"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });

    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("rejects an already-archived group when no lease still names a cancelled run", async () => {
    findFirst.mockResolvedValue({
      archivedAt: new Date("2026-09-26T00:00:00.000Z"),
      thread: { id: "thread-1" },
    });
    findManyRuns.mockResolvedValue([{ id: "run-reclaimed" }]);
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(queryRaw).toHaveBeenCalled();
    expect(leaseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId: { in: ["run-reclaimed"] },
          expiresAt: { gt: new Date(0) },
        },
      }),
    );
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(leaseUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects when the group is missing", async () => {
    findFirst.mockResolvedValue(null);
    const repos = createGroupRepos(prisma);
    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});
