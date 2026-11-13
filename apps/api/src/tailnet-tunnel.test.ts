import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { activeTailnetRun, activeTailnetScreen, tailnetTunnelEvent } from "./tailnet-tunnel.js";

const CLAIMS = {
  runId: "run1",
  userId: "alice",
  spaceId: "home",
  botId: "helper",
  expiresAt: Date.now() + 60_000,
};

describe("tailnet tunnel runs", () => {
  it("finds the run only while it is active and matches every claim", async () => {
    const findFirst = vi.fn(async () => ({ threadId: "thread1", bot: { name: "Helper" } }));
    const prisma = { run: { findFirst } } as unknown as Pick<PrismaClient, "run">;
    expect(await activeTailnetRun(prisma, CLAIMS)).toEqual({
      userId: "alice",
      spaceId: "home",
      botId: "helper",
      botName: "Helper",
      threadId: "thread1",
    });
    const [query] = findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> & { status: { in: string[] } } },
    ];
    expect(query.where).toMatchObject({
      id: "run1",
      userId: "alice",
      spaceId: "home",
      botId: "helper",
    });
    expect(query.where.status.in).toContain("running");
    expect(query.where.status.in).not.toContain("completed");
    findFirst.mockResolvedValueOnce(null as never);
    expect(await activeTailnetRun(prisma, CLAIMS)).toBeUndefined();
  });
});

describe("tailnet tunnel activity", () => {
  const run = { ...CLAIMS, botName: "Helper", threadId: "thread1" };
  const destination = { host: "nas.tail1234.ts.net", port: 22 };

  it("records a finished connection in the run's thread", () => {
    expect(
      tailnetTunnelEvent({
        run,
        destination,
        outcome: "closed",
        bytesSent: 10,
        bytesReceived: 32,
        durationMs: 5,
      }),
    ).toMatchObject({
      spaceId: "home",
      threadId: "thread1",
      botId: "helper",
      runId: "run1",
      type: "computer.command",
      payload: {
        kind: "tailnet",
        command: "nas.tail1234.ts.net:22",
        status: "done",
        exitCode: 0,
        output: "",
        bytes: 42,
      },
    });
  });

  it("records why a connection was refused", () => {
    expect(
      tailnetTunnelEvent({
        run,
        destination,
        outcome: "refused",
        reason: "Ask to connect to nas.tail1234.ts.net:22 first.",
        bytesSent: 0,
        bytesReceived: 0,
        durationMs: 1,
      }).payload,
    ).toMatchObject({ exitCode: 1, output: "Ask to connect to nas.tail1234.ts.net:22 first." });
  });
});

describe("who uses a bot's screen, for its browser", () => {
  const BOOT = new Date("2026-11-13T06:00:00.000Z");
  const PASS = { computerId: "computer1", boot: BOOT.toISOString() };
  const NOW = new Date("2026-11-13T07:00:00.000Z");
  const LATER = new Date("2026-11-13T07:10:00.000Z");

  function fixture(
    overrides: {
      computer?: Record<string, unknown> | null;
      lease?: { runId: string; expiresAt: Date } | null;
      run?: { userId: string; threadId: string } | null;
    } = {},
  ) {
    const computer =
      overrides.computer === null
        ? null
        : {
            spaceId: "home",
            state: "running",
            runningSince: BOOT,
            controlHolder: "none",
            controlUserId: null,
            controlBotId: null,
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            ...overrides.computer,
          };
    const runQuery = vi.fn(async () =>
      overrides.run === null ? null : (overrides.run ?? { userId: "alice", threadId: "thread1" }),
    );
    const prisma = {
      computer: { findUnique: async () => computer },
      bot: {
        findFirst: async ({ where }: { where: { id: string; spaceId: string } }) =>
          where.id === "helper" && where.spaceId === "home" ? { name: "Helper" } : null,
      },
      computerExecutionLease: {
        findUnique: async () =>
          overrides.lease === null
            ? null
            : (overrides.lease ?? { runId: "run1", expiresAt: LATER }),
      },
      run: { findFirst: runQuery },
    } as unknown as Parameters<typeof activeTailnetScreen>[0];
    return { prisma, runQuery };
  }
  const control = {
    controlHolder: "user",
    controlUserId: "bob",
    controlBotId: "helper",
    controlLeaseId: "lease1",
    controlLeaseExpiresAt: LATER,
  };

  it("is the member holding control of that bot's screen, even with its run waiting", async () => {
    const { prisma } = fixture({ computer: control });
    expect(await activeTailnetScreen(prisma, PASS, "helper", NOW)).toEqual({
      kind: "member",
      member: { userId: "bob", spaceId: "home", botId: "helper", botName: "Helper" },
    });
  });

  it("is the bot's run executing there, held to that run", async () => {
    const { prisma, runQuery } = fixture({
      computer: { ...control, controlBotId: "another-bot" },
    });
    expect(await activeTailnetScreen(prisma, PASS, "helper", NOW)).toEqual({
      kind: "run",
      run: {
        runId: "run1",
        userId: "alice",
        spaceId: "home",
        botId: "helper",
        botName: "Helper",
        threadId: "thread1",
      },
    });
    const [query] = runQuery.mock.calls[0] as unknown as [
      { where: { status: { in: string[] } } & Record<string, unknown> },
    ];
    expect(query.where).toMatchObject({ id: "run1", botId: "helper", spaceId: "home" });
    expect(query.where.status.in).not.toContain("completed");
  });

  it.each([
    [
      "control expired and no run",
      { computer: { ...control, controlLeaseExpiresAt: NOW }, lease: null },
    ],
    ["a lease that ran out", { lease: { runId: "run1", expiresAt: NOW } }],
    ["a run that ended", { run: null }],
    ["a computer started since the pass", { computer: { runningSince: LATER } }],
    ["a stopped computer", { computer: { state: "stopped" } }],
    ["a computer that is gone", { computer: null }],
  ] as const)("is nobody with %s", async (_case, overrides) => {
    const { prisma } = fixture(overrides as Parameters<typeof fixture>[0]);
    expect(await activeTailnetScreen(prisma, PASS, "helper", NOW)).toBeUndefined();
  });

  it("is nobody for a bot of another Space", async () => {
    const { prisma } = fixture({ computer: control });
    expect(await activeTailnetScreen(prisma, PASS, "elsewhere", NOW)).toBeUndefined();
  });
});
