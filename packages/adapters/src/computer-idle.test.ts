import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IDLE_MS, sandboxIdleMs, sleepComputerIfIdle } from "./computer-idle.js";
import {
  e2bCreateOptions,
  isUnreachableTransportError,
  isUnrecoverableSandboxError,
  openDesktopBrowser,
  openDesktopUrl,
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

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("rechecks the lease boundary after checkpointing before it suspends", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: { id: harness.computer.id },
      data: {
        state: "suspended",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
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
    // Transient transport codes must not satisfy the replaceComputer predicate: otherwise
    // update mode swallows a checkpoint blip, destroys the old box, and drops uncommitted work.
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isUnrecoverableSandboxError(reset)).toBe(false);
    expect(isUnreachableTransportError(reset)).toBe(true);
    expect(isUnrecoverableSandboxError(new Error("fetch failed"))).toBe(false);
    expect(isUnreachableTransportError(new Error("fetch failed"))).toBe(true);
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

  it("opens a URL through the named browser launcher", async () => {
    const launched: string[] = [];
    const commands = {
      run: async (cmd: string) => {
        launched.push(cmd);
        if (cmd.includes("google-chrome")) throw new Error("missing");
        if (cmd.includes("firefox")) return { exitCode: 0 };
        throw new Error("missing");
      },
    };
    await openDesktopUrl(
      {
        commands,
        launch: async () => {
          throw new Error("should use gtk-launch via commands");
        },
        open: async () => {
          throw new Error("should not fall back");
        },
      },
      "https://example.com/page",
    );
    expect(launched).toEqual([
      "gtk-launch 'google-chrome' 'https://example.com/page'",
      "gtk-launch 'firefox' 'https://example.com/page'",
    ]);
  });
});

function idleHarness(options: { exportError?: Error } = {}) {
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    providerRef: "computer",
    kind: "e2b",
    state: "running",
    workspaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionBotId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  let checkpointedAt = computer.updatedAt;
  const prisma = {
    computer: {
      findUnique: vi.fn(async () => ({ ...computer, updatedAt: checkpointedAt })),
      updateMany: vi.fn(async (args) => {
        if (args.data.updatedAt) checkpointedAt = args.data.updatedAt;
        if (args.data.state) computer.state = args.data.state;
        return { count: 1 };
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
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
