import type { BackgroundJob, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TAKEOVER_LEASE_MS,
  expireComputerControl,
  hasActiveComputerControl,
  takeoverLeaseMs,
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
      replaceKey: "computer.control-expire:computer-id",
    });
    expect(harness.setScreenControl).not.toHaveBeenCalled();
  });

  it("denies control, revokes the stream, clears the lease, and publishes expiry", async () => {
    const harness = controlHarness();

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
      workspaceId: "workspace",
      computerId: "computer-id",
      botId: "bot",
      leaseId: "lease-1",
      holder: "none",
      reason: "expired",
    });
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
});

function controlHarness(
  options: {
    controlLeaseId?: string;
    controlLeaseExpiresAt?: Date | null;
    revokeError?: Error;
    finalizeError?: Error;
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
    controlBotId: "bot",
    controlLeaseExpiresAt:
      options.controlLeaseExpiresAt === undefined
        ? new Date("2026-01-01T00:00:00.000Z")
        : options.controlLeaseExpiresAt,
    workspaceId: "workspace",
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
  const jobs = { enqueue, cancel: vi.fn(), close: vi.fn() };
  const finalizeComputerControlRelease = vi.fn().mockResolvedValue(true);
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
