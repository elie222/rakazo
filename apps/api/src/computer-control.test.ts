import { clearInactiveUserComputerControl, expireComputerControl } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
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
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(expireComputerControl).mockReset();
    vi.mocked(clearInactiveUserComputerControl).mockReset();
    logged = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  it("ends a lapsed lease and asks the caller to read the computer again", async () => {
    vi.mocked(expireComputerControl).mockResolvedValue(true);
    await expect(expireStaleComputerControl(deps, lapsed)).resolves.toBe(true);
    expect(expireComputerControl).toHaveBeenCalledWith(deps, "computer-1", "lease-1");
    expect(logged).not.toHaveBeenCalled();
  });

  it("reports a failed expiry while the read that found it still answers", async () => {
    const failure = new Error("provider unavailable");
    vi.mocked(expireComputerControl).mockRejectedValue(failure);
    await expect(expireStaleComputerControl(deps, lapsed)).resolves.toBe(true);
    expect(logged).toHaveBeenCalledWith("stale computer control expiry", failure);
  });

  it("reports a failed retry of a revoke that stopped half way", async () => {
    const failure = new Error("provider unavailable");
    vi.mocked(expireComputerControl).mockRejectedValue(failure);
    await expect(
      expireStaleComputerControl(deps, { ...lapsed, controlHolder: "none" }),
    ).resolves.toBe(true);
    expect(logged).toHaveBeenCalledWith("stale computer control expiry", failure);
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
