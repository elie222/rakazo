import type { ModelQuota } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { modelUsageRoleRank, sortModelUsageEntries } from "./model-usage-sort.js";

const quota = (remaining: number): ModelQuota => ({
  credentialId: "connection",
  status: "fresh",
  observedAt: "2030-01-01T00:00:00.000Z",
  checkedAt: "2030-01-01T00:00:00.000Z",
  windows: [{ id: "seven_day", usedPercent: 100 - remaining, resetsAt: null, modelIds: null }],
});

const entries = [
  { id: "ten", label: "Provider 10", quota: quota(10), mainRank: 1, approvalRank: 0 },
  { id: "two", label: "Provider 2", quota: quota(80), mainRank: 0, approvalRank: 1 },
  { id: "unknown", label: "Provider 3", quota: null, mainRank: null, approvalRank: null },
];

describe("provider usage sorting", () => {
  it("sorts by most remaining allowance and keeps unknown readings last", () => {
    expect(sortModelUsageEntries(entries, "quota").map((entry) => entry.id)).toEqual([
      "two",
      "ten",
      "unknown",
    ]);
    expect(sortModelUsageEntries(entries, "quota", true).map((entry) => entry.id)).toEqual([
      "ten",
      "two",
      "unknown",
    ]);
  });

  it("sorts model roles by their configured order and inverts only that order", () => {
    expect(sortModelUsageEntries(entries, "main-model").map((entry) => entry.id)).toEqual([
      "two",
      "ten",
      "unknown",
    ]);
    expect(sortModelUsageEntries(entries, "approval-model").map((entry) => entry.id)).toEqual([
      "ten",
      "two",
      "unknown",
    ]);
    expect(sortModelUsageEntries(entries, "main-model", true).map((entry) => entry.id)).toEqual([
      "ten",
      "two",
      "unknown",
    ]);
  });

  it("sorts alphabetically with numeric names and resolves role rank by credential", () => {
    expect(sortModelUsageEntries(entries, "alphabetical").map((entry) => entry.id)).toEqual([
      "two",
      "unknown",
      "ten",
    ]);
    expect(sortModelUsageEntries(entries, "alphabetical", true).map((entry) => entry.id)).toEqual([
      "ten",
      "unknown",
      "two",
    ]);
    expect(
      modelUsageRoleRank(
        {
          primary: { provider: "compatible", modelId: "main", credentialId: "two" },
          backups: [{ provider: "compatible", modelId: "backup", credentialId: "ten" }],
        },
        "ten",
        "compatible",
      ),
    ).toBe(1);
  });
});
