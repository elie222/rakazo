import { clearInactiveUserComputerControl, expireComputerControl } from "@rakazo/adapters";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expireStaleComputerControl } from "./computer-control.js";
import type { RouterDeps } from "./router.js";

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  expireComputerControl: vi.fn(),
  clearInactiveUserComputerControl: vi.fn(),
}));

const deps = { prisma: {} } as unknown as RouterDeps;
const lapsed = {
  id: "computer-1",
  controlHolder: "user",
  controlLeaseId: "lease-1",
  controlLeaseExpiresAt: new Date(0),
};

describe("expireStaleComputerControl", () => {
  let sink: TestSink;
  const expiryFailed = {
    level: "warn",
    message: "stale computer control expiry failed",
    "computer.id": "computer-1",
    "control.lease.id": "lease-1",
    error: { message: "provider unavailable" },
  };

  beforeEach(() => {
    vi.mocked(expireComputerControl).mockReset();
    vi.mocked(clearInactiveUserComputerControl).mockReset();
    sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
  });
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("ends a lapsed lease and asks the caller to read the computer again", async () => {
    vi.mocked(expireComputerControl).mockResolvedValue(true);
    await expect(expireStaleComputerControl(deps, lapsed)).resolves.toBe(true);
    expect(expireComputerControl).toHaveBeenCalledWith(deps, "computer-1", "lease-1");
    expect(sink.events).toEqual([]);
  });

  it("warns with the computer and lease on each read that fails to expire a stuck lease", async () => {
    vi.mocked(expireComputerControl).mockRejectedValue(new Error("provider unavailable"));
    await expect(expireStaleComputerControl(deps, lapsed)).resolves.toBe(true);
    await expect(expireStaleComputerControl(deps, lapsed)).resolves.toBe(true);
    expect(sink.events).toMatchObject([expiryFailed, expiryFailed]);
  });

  it("warns the same way for a failed retry of a revoke that stopped half way", async () => {
    vi.mocked(expireComputerControl).mockRejectedValue(new Error("provider unavailable"));
    await expect(
      expireStaleComputerControl(deps, { ...lapsed, controlHolder: "none" }),
    ).resolves.toBe(true);
    expect(sink.events).toMatchObject([expiryFailed]);
  });

  it("clears control left without a lease", async () => {
    vi.mocked(clearInactiveUserComputerControl).mockResolvedValue(true);
    await expect(
      expireStaleComputerControl(deps, { ...lapsed, controlLeaseId: null }),
    ).resolves.toBe(true);
    vi.mocked(clearInactiveUserComputerControl).mockResolvedValue(false);
    await expect(
      expireStaleComputerControl(deps, { ...lapsed, controlLeaseId: null }),
    ).resolves.toBe(false);
  });

  it("reports a failed clear instead of answering that nothing changed", async () => {
    vi.mocked(clearInactiveUserComputerControl).mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      expireStaleComputerControl(deps, { ...lapsed, controlLeaseId: null }),
    ).rejects.toThrow("database unavailable");
  });
});
