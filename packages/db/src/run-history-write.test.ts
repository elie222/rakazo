import { describe, expect, it } from "vitest";
import { runHistoryWriteBlock } from "./run-history-write.js";

const holder = { owner: "worker", fence: 2 };

describe("runHistoryWriteBlock", () => {
  it("allows the holder and a paused owner when the fence matches", () => {
    expect(
      runHistoryWriteBlock(
        { status: "running", leaseOwner: "worker", leaseFence: 2 },
        { lease: holder },
      ),
    ).toBeNull();
    expect(
      runHistoryWriteBlock(
        { status: "running", leaseOwner: null, leaseFence: 2 },
        { lease: holder },
      ),
    ).toBeNull();
    expect(
      runHistoryWriteBlock({ status: "running", leaseOwner: "worker", leaseFence: 2 }),
    ).toBeNull();
    expect(
      runHistoryWriteBlock(
        { status: "cancelled", leaseOwner: "worker", leaseFence: 2 },
        { allowCancelled: true, lease: holder },
      ),
    ).toBeNull();
  });

  it("rejects a superseded fence while the run is still running", () => {
    expect(
      runHistoryWriteBlock(
        { status: "running", leaseOwner: "other", leaseFence: 3 },
        { lease: holder },
      ),
    ).toBe("superseded");
    expect(
      runHistoryWriteBlock(
        { status: "running", leaseOwner: "worker", leaseFence: 3 },
        { lease: holder },
      ),
    ).toBe("superseded");
    expect(
      runHistoryWriteBlock(
        { status: "running", leaseOwner: null, leaseFence: 3 },
        { lease: holder },
      ),
    ).toBe("superseded");
    expect(
      runHistoryWriteBlock(
        { status: "cancelled", leaseOwner: "worker", leaseFence: 2 },
        { lease: holder },
      ),
    ).toBe("cancelled");
    expect(runHistoryWriteBlock(null, { lease: holder })).toBe("missing");
  });
});
