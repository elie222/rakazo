import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IDLE_MS, sandboxIdleMs, sleepComputerIfIdle } from "./computer-idle.js";
import {
  e2bCreateOptions,
  isUnrecoverableSandboxError,
  openDesktopBrowser,
} from "./e2b-sandbox.js";

describe("sandbox idle", () => {
  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    const previous = process.env.SANDBOX_IDLE_MS;
    delete process.env.SANDBOX_IDLE_MS;
    try {
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
      expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_IDLE_MS;
      else process.env.SANDBOX_IDLE_MS = previous;
    }
  });

  it("does not suspend a computer while a run is active", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, "bot");

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.computer.findUnique
      .mockResolvedValueOnce(harness.computer)
      .mockResolvedValueOnce({
        state: "running",
        providerRef: harness.computer.providerRef,
        updatedAt: harness.computer.updatedAt,
      });
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, "bot");

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("rechecks the lease boundary after checkpointing before it suspends", async () => {
    const harness = idleHarness();
    harness.prisma.computer.findUnique
      .mockResolvedValueOnce(harness.computer)
      .mockResolvedValueOnce({
        state: "running",
        providerRef: harness.computer.providerRef,
        updatedAt: new Date(harness.computer.updatedAt.getTime() + 1),
      });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, "bot");

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.computer.findUnique
      .mockResolvedValueOnce(harness.computer)
      .mockResolvedValueOnce({
        state: "running",
        providerRef: harness.computer.providerRef,
        updatedAt: harness.computer.updatedAt,
      });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, "bot");

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: { botId: "bot" },
      data: {
        state: "suspended",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, "bot")).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });

  it("only recreates when the sandbox is actually gone", () => {
    expect(isUnrecoverableSandboxError(new Error("sandbox not found"))).toBe(true);
    expect(isUnrecoverableSandboxError(new Error("ECONNRESET"))).toBe(false);
  });

  it("opens a browser on a new desktop", async () => {
    const launched: string[] = [];
    await openDesktopBrowser({
      launch: async (application) => {
        launched.push(application);
        if (application !== "firefox") throw new Error("missing");
      },
      open: async () => {
        throw new Error("should not fall back");
      },
    });
    expect(launched).toEqual(["google-chrome", "firefox"]);
  });
});

function idleHarness(options: { exportError?: Error } = {}) {
  const computer = {
    botId: "bot",
    providerRef: "computer",
    kind: "e2b",
    state: "running",
    workspaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const prisma = {
    computer: {
      findUnique: vi.fn().mockResolvedValue(computer),
      update: vi.fn().mockResolvedValue(undefined),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findUnique: vi.fn().mockResolvedValue({ id: "bot", thread: { id: "thread" } }),
    },
  };
  const sandbox = {
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  return {
    computer,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}
