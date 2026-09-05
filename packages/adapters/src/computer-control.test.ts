import type { BackgroundJob, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  clearInactiveUserComputerControl,
  DEFAULT_TAKEOVER_LEASE_MS,
  expireComputerControl,
  extendActiveComputerControl,
  hasActiveComputerControl,
  takeoverLeaseMs,
  teachingControlLeaseExpiresAt,
} from "./computer-control.js";

describe("computer control leases", () => {
  it("defaults to fifteen minutes and rejects unsafe configuration", () => {
    const previous = process.env.COMPUTER_TAKEOVER_TTL_MS;
    try {
      delete process.env.COMPUTER_TAKEOVER_TTL_MS;
      expect(takeoverLeaseMs()).toBe(15 * 60 * 1000);
      process.env.COMPUTER_TAKEOVER_TTL_MS = "999";
      expect(takeoverLeaseMs()).toBe(DEFAULT_TAKEOVER_LEASE_MS);
      process.env.COMPUTER_TAKEOVER_TTL_MS = "1000";
      expect(takeoverLeaseMs()).toBe(1000);
    } finally {
      if (previous === undefined) delete process.env.COMPUTER_TAKEOVER_TTL_MS;
      else process.env.COMPUTER_TAKEOVER_TTL_MS = previous;
    }
  });

  it("requires every persisted lease boundary to authorize control", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const active = {
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(now.getTime() + 1),
    };
    expect(hasActiveComputerControl(active, now)).toBe(true);
    expect(hasActiveComputerControl({ ...active, controlHolder: "none" }, now)).toBe(false);
    expect(hasActiveComputerControl({ ...active, controlLeaseId: null }, now)).toBe(false);
    expect(hasActiveComputerControl({ ...active, controlLeaseExpiresAt: now }, now)).toBe(false);
  });

  it("reschedules an early delivery without revoking control", async () => {
    const expiresAt = new Date("2026-01-01T00:00:01.000Z");
    const harness = controlHarness({ controlLeaseExpiresAt: expiresAt });

    await expect(
      expireComputerControl(
        harness.deps,
        "computer-id",
        "lease-1",
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(false);

    expect(harness.enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-id", leaseId: "lease-1" },
      availableAt: expiresAt,
      replaceKey: "computer.control-expire:computer-id:lease-1",
    });
    expect(harness.setScreenControl).not.toHaveBeenCalled();
  });

  it("denies control, revokes the stream, clears the lease, and publishes expiry", async () => {
    const harness = controlHarness({ waitingRunId: "run-1" });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.prisma.computer.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "computer-id", controlLeaseId: "lease-1" },
      data: { controlHolder: "none" },
    });
    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer" }),
      false,
      expect.objectContaining({ operationId: "computer.control-expire" }),
      "lease-1",
    );
    expect(harness.events.finalizeComputerControlRelease).toHaveBeenCalledWith({
      spaceId: "workspace",
      computerId: "computer-id",
      botId: "bot",
      runId: "run-1",
      leaseId: "lease-1",
      holder: "none",
      reason: "expired",
    });
    expect(harness.enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-1" },
      replaceKey: "run:run-1",
    });
  });

  it("resumes the run holding the takeover lease instead of a newer waiting run", async () => {
    const harness = controlHarness({ controlRunId: "run-holding-takeover" });

    await expireComputerControl(harness.deps, "computer-id", "lease-1");

    expect(harness.events.finalizeComputerControlRelease).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-holding-takeover" }),
    );
  });

  it("does not release a run acquired after the control lease", async () => {
    const harness = controlHarness({
      controlRunId: "run-holding-takeover",
      executionRunId: "newer-run",
    });

    await expireComputerControl(harness.deps, "computer-id", "lease-1");

    expect(harness.events.finalizeComputerControlRelease).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-holding-takeover" }),
    );
  });

  it("leaves a released run recoverable when its immediate continuation enqueue fails", async () => {
    const enqueueError = new Error("job broker unavailable");
    const harness = controlHarness({ waitingRunId: "run-1", enqueueError });
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(sink.events.some((event) => event.message === "takeover continuation enqueue")).toBe(
      true,
    );
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("keeps the denied lease retryable when provider revocation fails", async () => {
    const harness = controlHarness({
      revokeError: new Error("provider unavailable"),
    });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).rejects.toThrow(
      "provider unavailable",
    );

    expect(harness.prisma.computer.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-id", controlLeaseId: "lease-1" },
      data: { controlHolder: "none" },
    });
    expect(harness.events.finalizeComputerControlRelease).not.toHaveBeenCalled();
  });

  it("retries atomic lease cleanup when release-event persistence fails", async () => {
    const harness = controlHarness({ finalizeError: new Error("event unavailable") });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).rejects.toThrow(
      "event unavailable",
    );
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.events.finalizeComputerControlRelease).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a replacement lease", async () => {
    const harness = controlHarness({ controlLeaseId: "lease-2" });
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(
      false,
    );
    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("clears stale user control when the lease is empty or expired", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { computer: { updateMany } } as unknown as PrismaClient;
    const now = new Date("2026-01-01T00:00:00.000Z");

    await expect(clearInactiveUserComputerControl(prisma, "computer-1", now)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        controlHolder: "user",
        OR: [
          { controlLeaseId: null },
          { controlLeaseExpiresAt: null },
          { controlLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
  });

  it("revokes then clears orphaned user control when expiry has no control bot id", async () => {
    const harness = controlHarness({ controlBotId: null });
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);
    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer" }),
      false,
      expect.objectContaining({ operationId: "computer.control-expire" }),
      "lease-1",
    );
    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-id",
        controlLeaseId: "lease-1",
      },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
  });

  it("keeps an orphaned lease when provider revocation fails", async () => {
    const harness = controlHarness({
      controlBotId: null,
      revokeError: new Error("provider unavailable"),
    });
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(
      false,
    );
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.enqueue).toHaveBeenCalled();
  });

  it("keeps an orphaned lease when revoke and reschedule both fail", async () => {
    const harness = controlHarness({
      controlBotId: null,
      revokeError: new Error("provider unavailable"),
      enqueueError: new Error("queue unavailable"),
    });
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(
      false,
    );
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(sink.events.length).toBeGreaterThan(0);
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });
});

describe("teaching control lease extension", () => {
  it("covers the teaching window and the default takeover ttl", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(teachingControlLeaseExpiresAt(new Date("2026-01-01T00:10:00.000Z"), now)).toEqual(
      new Date(now.getTime() + DEFAULT_TAKEOVER_LEASE_MS),
    );
    expect(teachingControlLeaseExpiresAt(new Date("2026-01-01T00:20:00.000Z"), now)).toEqual(
      new Date("2026-01-01T00:20:00.000Z"),
    );
  });

  it("extends an existing user lease and reschedules expiry", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const teachingUntil = new Date("2026-01-01T00:10:00.000Z");
    const harness = controlHarness({
      controlLeaseExpiresAt: new Date("2026-01-01T00:04:00.000Z"),
    });
    const computer = {
      id: "computer-id",
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date("2026-01-01T00:04:00.000Z"),
      controlBotId: "bot",
    };

    await expect(
      extendActiveComputerControl(
        harness.deps.prisma,
        harness.deps.jobs,
        computer,
        "bot",
        teachingUntil,
        now,
      ),
    ).resolves.toBe(true);

    const expectedExpiry = new Date(now.getTime() + DEFAULT_TAKEOVER_LEASE_MS);
    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-id",
        controlHolder: "user",
        controlBotId: "bot",
        controlLeaseId: "lease-1",
      },
      data: { controlLeaseExpiresAt: expectedExpiry },
    });
    expect(harness.enqueue).toHaveBeenCalled();
  });
});

function controlHarness(
  options: {
    controlLeaseId?: string;
    controlLeaseExpiresAt?: Date | null;
    controlBotId?: string | null;
    revokeError?: Error;
    finalizeError?: Error;
    enqueueError?: Error;
    waitingRunId?: string;
    controlRunId?: string;
    executionRunId?: string;
  } = {},
) {
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    providerRef: "computer",
    kind: "docker",
    state: "running",
    controlHolder: "user",
    controlLeaseId: options.controlLeaseId ?? "lease-1",
    controlBotId: options.controlBotId === undefined ? "bot" : options.controlBotId,
    controlRunId: options.controlRunId ?? options.waitingRunId ?? null,
    executionRunId: options.executionRunId ?? null,
    controlLeaseExpiresAt:
      options.controlLeaseExpiresAt === undefined
        ? new Date("2026-01-01T00:00:00.000Z")
        : options.controlLeaseExpiresAt,
    spaceId: "workspace",
    userId: "user",
  };
  const prisma = {
    computer: {
      findUnique: vi.fn().mockResolvedValue(computer),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    bot: {
      findUnique: vi.fn().mockResolvedValue({
        id: "bot",
        thread: { id: "thread" },
        computer,
      }),
    },
  };
  const setScreenControl = vi.fn(async () => {
    if (options.revokeError) throw options.revokeError;
  });
  const sandbox = { setScreenControl };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  if (options.enqueueError) enqueue.mockRejectedValueOnce(options.enqueueError);
  const jobs = { enqueue, cancel: vi.fn(), close: vi.fn() };
  const finalizeComputerControlRelease = vi.fn().mockResolvedValue({
    runId: options.controlRunId ?? options.waitingRunId ?? null,
  });
  if (options.finalizeError) {
    finalizeComputerControlRelease.mockRejectedValueOnce(options.finalizeError);
  }
  const events = {
    append: vi.fn().mockResolvedValue({}),
    finalizeComputerControlRelease,
  };
  return {
    prisma,
    setScreenControl,
    enqueue,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}
