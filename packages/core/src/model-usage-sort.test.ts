import type { ModelCredential, ModelQuota } from "@rakazo/contracts";
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
        [],
      ),
    ).toBe(1);
  });

  it("resolves a role without a credential id to the account that owns its model", () => {
    const credentials: ModelCredential[] = [
      {
        id: "unused-codex",
        provider: "openai-codex",
        label: "Unused",
        hasKey: true,
        isDefault: false,
        modelId: "gpt-5.6-sol",
        preferenceRank: 0,
      },
      {
        id: "main-codex",
        provider: "openai-codex",
        label: "Main",
        hasKey: true,
        isDefault: true,
        modelId: "gpt-6-luna",
        preferenceRank: 1,
      },
    ];
    const role = {
      primary: { provider: "openai-codex", modelId: "gpt-6-luna" },
      backups: [],
    };
    expect(modelUsageRoleRank(role, "main-codex", credentials)).toBe(0);
    expect(modelUsageRoleRank(role, "unused-codex", credentials)).toBeNull();
  });

  it("resolves unpinned compatible roles to the connection that enables the model", () => {
    const credentials: ModelCredential[] = [
      {
        id: "preferred",
        provider: "openai-compatible",
        label: "Preferred",
        hasKey: true,
        isDefault: true,
        modelId: "other-model",
        preferenceRank: 0,
        enabledModelIds: ["other-model"],
      },
      {
        id: "serving",
        provider: "openai-compatible",
        label: "Serving",
        hasKey: true,
        isDefault: false,
        enabledModelIds: ["main-model"],
      },
    ];
    const role = {
      primary: { provider: "openai-compatible", modelId: "main-model" },
      backups: [],
    };
    expect(modelUsageRoleRank(role, "serving", credentials)).toBe(0);
    expect(modelUsageRoleRank(role, "preferred", credentials)).toBeNull();
  });
});
