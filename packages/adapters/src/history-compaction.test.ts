import { describe, expect, it } from "vitest";
import { nextCompactionBatchRange, shouldEnqueueCompaction } from "./history-compaction.js";

describe("shouldEnqueueCompaction", () => {
  it("is false when nothing has aged out of the window yet", () => {
    expect(shouldEnqueueCompaction(99, null, 50, 50)).toBe(false);
  });

  it("is true once a full batch has aged out beyond the window", () => {
    expect(shouldEnqueueCompaction(100, null, 50, 50)).toBe(true);
  });

  it("accounts for messages already compacted", () => {
    expect(shouldEnqueueCompaction(149, 50, 50, 50)).toBe(false);
    expect(shouldEnqueueCompaction(150, 50, 50, 50)).toBe(true);
  });
});

describe("nextCompactionBatchRange", () => {
  it("starts from the beginning when nothing has been compacted", () => {
    expect(nextCompactionBatchRange(null, 50)).toEqual({ fromSeqExclusive: 0, take: 50 });
  });

  it("continues from the cursor when something has already been compacted", () => {
    expect(nextCompactionBatchRange(50, 50)).toEqual({ fromSeqExclusive: 50, take: 50 });
  });
});
