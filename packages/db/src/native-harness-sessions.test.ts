import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { resolveExecutionHandover } from "./execution-handover.js";
import {
  claimNativeHarnessSession,
  updateNativeHarnessSession,
} from "./native-harness-sessions.js";

vi.mock("./execution-handover.js", () => ({
  resolveExecutionHandover: vi.fn().mockResolvedValue(null),
}));

vi.mock("./execution-profiles.js", () => ({
  resolveRunExecutionProfile: vi.fn().mockResolvedValue({
    profile: { id: "profile" },
    snapshot: { credentialId: "account", credentialSecretId: "current-secret" },
  }),
  ExecutionProfileUnavailableError: class extends Error {},
}));

const scope = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  threadId: "thread",
  profileId: "profile",
  runId: "run",
  leaseFence: 3,
};

function fixture(overrides: Record<string, unknown> = {}) {
  const session = {
    id: "session",
    ...scope,
    nativeSessionId: "opaque",
    credentialSecretId: "current-secret",
    epoch: "old-epoch",
    activeRunId: null,
    activeLeaseFence: null,
    interrupted: false,
    interruptedRunId: null,
    ...overrides,
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "run" }]),
    run: { findFirst: vi.fn().mockResolvedValue({ id: "run", ...scope }) },
    nativeHarnessSession: {
      upsert: vi.fn().mockResolvedValue(session),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return { db, prisma: db as unknown as PrismaClient };
}

describe("native session fencing", () => {
  it("keys continuations by target bot, thread and immutable profile", async () => {
    const { db, prisma } = fixture();
    const session = await claimNativeHarnessSession(prisma, scope);
    expect(session.nativeSessionId).toBe("opaque");
    expect(db.nativeHarnessSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId_threadId_profileId: { botId: "bot", threadId: "thread", profileId: "profile" },
        },
      }),
    );
    expect(db.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "run",
          leaseFence: 3,
          threadId: "thread",
          userId: "user",
        }),
      }),
    );
  });

  it("rejects a concurrent run or stale attempt lease", async () => {
    const { db, prisma } = fixture();
    db.nativeHarnessSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimNativeHarnessSession(prisma, scope)).rejects.toThrow("already in use");
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ activeRunId: null }, { activeRunId: "run", activeLeaseFence: 3 }],
        }),
      }),
    );
  });

  it("pauses without marking a deliberate approval wait as interrupted", async () => {
    const { db, prisma } = fixture();
    await updateNativeHarnessSession(prisma, { ...scope, outcome: "paused" });
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        userId: "user",
        botId: "bot",
        threadId: "thread",
        profileId: "profile",
        activeRunId: "run",
        activeLeaseFence: 3,
      },
      data: {
        activeRunId: null,
        activeLeaseFence: null,
        interrupted: false,
        interruptedRunId: null,
      },
    });
  });

  it("marks an interrupted run and refuses its automatic replay", async () => {
    const { db, prisma } = fixture({ interrupted: true, interruptedRunId: "run" });
    db.nativeHarnessSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      claimNativeHarnessSession(prisma, { ...scope, startNewSession: true }),
    ).rejects.toThrow("interrupted");
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lets a fresh explicitly requested run rebuild from canonical history", async () => {
    const { db, prisma } = fixture({ interrupted: true, interruptedRunId: "old-run" });
    const session = await claimNativeHarnessSession(prisma, { ...scope, startNewSession: true });
    expect(session.nativeSessionId).toBeNull();
    expect(session.epoch).not.toBe("old-epoch");
    expect(session.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledTimes(2);
  });

  it("rotates the session epoch after reconnecting the same credential ID", async () => {
    const { db, prisma } = fixture({ credentialSecretId: "previous-secret" });
    const session = await claimNativeHarnessSession(prisma, scope);
    expect(session.nativeSessionId).toBeNull();
    expect(session.epoch).not.toBe("old-epoch");
    expect(session.credentialSecretId).toBe("current-secret");
    expect(db.nativeHarnessSession.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          credentialSecretId: "previous-secret",
          activeRunId: null,
        }),
        data: expect.objectContaining({
          credentialSecretId: "current-secret",
          nativeSessionId: null,
        }),
      }),
    );
  });

  it("does not take over an active session from the previous account connection", async () => {
    const { db, prisma } = fixture({
      credentialSecretId: "previous-secret",
      activeRunId: "older-run",
      activeLeaseFence: 1,
    });
    db.run.findFirst
      .mockResolvedValueOnce({ id: "run", ...scope })
      .mockResolvedValueOnce({ status: "running" });
    await expect(claimNativeHarnessSession(prisma, scope)).rejects.toThrow(
      "previous account connection",
    );
    expect(db.nativeHarnessSession.updateMany).not.toHaveBeenCalled();
  });

  it("discards a terminal previous-account session even for a scheduled new run", async () => {
    const { db, prisma } = fixture({
      credentialSecretId: "previous-secret",
      activeRunId: "older-run",
      activeLeaseFence: 1,
    });
    db.run.findFirst
      .mockResolvedValueOnce({ id: "run", ...scope })
      .mockResolvedValueOnce({ status: "failed" });
    const session = await claimNativeHarnessSession(prisma, scope);
    expect(session.nativeSessionId).toBeNull();
    expect(session.epoch).not.toBe("old-epoch");
    expect(session.credentialSecretId).toBe("current-secret");
  });

  it("rejects a reconnect racing with session compatibility validation", async () => {
    const { db, prisma } = fixture();
    db.$queryRaw
      .mockResolvedValueOnce([{ id: "thread" }])
      .mockResolvedValueOnce([{ id: "run" }])
      .mockResolvedValueOnce([]);
    await expect(claimNativeHarnessSession(prisma, scope)).rejects.toThrow(
      "account connection changed",
    );
    expect(db.nativeHarnessSession.upsert).not.toHaveBeenCalled();
  });

  it("rejects stale run fences before touching checkpoint storage", async () => {
    const { db, prisma } = fixture();
    db.$queryRaw.mockResolvedValueOnce([{ id: "thread" }]).mockResolvedValueOnce([]);
    await expect(
      updateNativeHarnessSession(prisma, { ...scope, nativeSessionId: "new" }),
    ).rejects.toThrow("run lease is no longer current");
    expect(db.nativeHarnessSession.updateMany).not.toHaveBeenCalled();
  });

  it("does not let a stale run overwrite native continuation state", async () => {
    const { db, prisma } = fixture();
    db.nativeHarnessSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      updateNativeHarnessSession(prisma, {
        ...scope,
        nativeSessionId: "replacement",
        outcome: "completed",
      }),
    ).rejects.toThrow("lease no longer belongs");
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeRunId: "run", activeLeaseFence: 3 }),
      }),
    );
  });
});

describe("execution profile handover", () => {
  it("rotates a previously used profile when switching back", async () => {
    vi.mocked(resolveExecutionHandover).mockResolvedValueOnce({
      previousHarness: "codex",
      currentHarness: "claude",
      summary: "handover",
    });
    const { db, prisma } = fixture({ lastRunId: "earlier-profile-run" });
    const session = await claimNativeHarnessSession(prisma, scope);
    expect(session.epoch).not.toBe("old-epoch");
    expect(session.nativeSessionId).toBeNull();
    expect(db.nativeHarnessSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastRunId: "run" }) }),
    );
  });
  it("retains a switched profile's checkpoint across approval resume", async () => {
    vi.mocked(resolveExecutionHandover).mockResolvedValueOnce({
      previousHarness: "codex",
      currentHarness: "claude",
      summary: "handover",
    });
    const { db, prisma } = fixture({ lastRunId: "run" });
    const session = await claimNativeHarnessSession(prisma, scope);
    expect(session.epoch).toBe("old-epoch");
    expect(session.nativeSessionId).toBe("opaque");
    expect(db.nativeHarnessSession.updateMany).toHaveBeenCalledTimes(1);
  });
  it("does not steal an active session during a profile switch", async () => {
    vi.mocked(resolveExecutionHandover).mockResolvedValueOnce({
      previousHarness: "codex",
      currentHarness: "claude",
      summary: "handover",
    });
    const { db, prisma } = fixture({
      lastRunId: "other",
      activeRunId: "other",
      activeLeaseFence: 2,
    });
    db.run.findFirst
      .mockResolvedValueOnce({ id: "run", ...scope })
      .mockResolvedValueOnce({ status: "running" });
    await expect(claimNativeHarnessSession(prisma, scope)).rejects.toThrow("still active");
    expect(db.nativeHarnessSession.updateMany).not.toHaveBeenCalled();
  });
});
