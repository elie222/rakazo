import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureReferral, claimStoredReferral } from "./referral";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { billing: { claimReferral: vi.fn() } },
}));

describe("referral", () => {
  const claimReferral = vi.mocked(rpc.billing.claimReferral);
  let storage: Map<string, string>;

  beforeEach(() => {
    claimReferral.mockReset();
    storage = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims a code from the landing URL once", async () => {
    claimReferral.mockResolvedValue({ ok: true });
    captureReferral("?ref=friend42");

    await claimStoredReferral();
    await claimStoredReferral();

    expect(claimReferral).toHaveBeenCalledTimes(1);
    expect(claimReferral).toHaveBeenCalledWith({ code: "friend42" });
  });

  it("keeps the code for another try when the claim fails", async () => {
    claimReferral.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    captureReferral("?ref=friend42");

    await claimStoredReferral();
    await claimStoredReferral();

    expect(claimReferral).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a code", async () => {
    captureReferral("?plans");

    await claimStoredReferral();

    expect(claimReferral).not.toHaveBeenCalled();
  });
});
