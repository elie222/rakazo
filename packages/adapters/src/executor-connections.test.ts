import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { mergeConnectedPlugins } from "./composio-connector.js";
import { persistLivePluginConnections, selectRunConnections } from "./executor.js";

describe("run connection selection", () => {
  it("uses synchronized account statuses in the current run", async () => {
    const rows = [
      { id: "gmail", provider: "gmail", status: "error" },
      { id: "slack", provider: "slack", status: "revoked" },
      { id: "slack-old", provider: "slack", status: "revoked" },
      { id: "gmail-duplicate", provider: "gmail", status: "pending" },
    ].map((row) => ({ ...row, connectorId: "composio", displayName: row.provider }));
    const prisma = {
      connection: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    } as unknown as PrismaClient;
    const liveSlugs = ["gmail", "slack"];

    await persistLivePluginConnections(
      prisma,
      { userId: "user", spaceId: "space" },
      rows,
      liveSlugs,
    );

    expect(rows.map((row) => row.status)).toEqual(["connected", "connected", "revoked", "revoked"]);
    expect(
      selectRunConnections(
        rows,
        mergeConnectedPlugins(rows, liveSlugs).map((row) => row.provider),
      ),
    ).toEqual([rows[0], rows[1]]);
  });

  it("does not recover a revoked account when persistence fails", async () => {
    const rows = [
      {
        id: "slack",
        connectorId: "composio",
        provider: "slack",
        displayName: "Slack",
        status: "revoked",
      },
    ];
    const prisma = {
      connection: { updateMany: vi.fn().mockRejectedValue(new Error("database unavailable")) },
    } as unknown as PrismaClient;
    await expect(
      persistLivePluginConnections(prisma, { userId: "user", spaceId: "space" }, rows, ["slack"]),
    ).rejects.toThrow("database unavailable");
    expect(selectRunConnections(rows, ["slack"])).toEqual([]);
  });

  it("does not send revoked accounts alongside a reconnected toolkit", () => {
    const oldAccount = {
      connectorId: "composio",
      provider: "youtube",
      status: "revoked",
      providerRef: "ca_old",
    };
    const currentAccount = { ...oldAccount, status: "connected", providerRef: "ca_current" };
    expect(selectRunConnections([oldAccount, currentAccount], ["youtube"])).toEqual([
      currentAccount,
    ]);
  });

  it("preserves live connection recovery and connected accounts from other providers", () => {
    const pending = { connectorId: "composio", provider: "youtube", status: "pending" };
    const revoked = { ...pending, status: "revoked" };
    const other = { connectorId: "pipedream", provider: "youtube", status: "connected" };
    const disconnected = { ...other, status: "error" };
    expect(selectRunConnections([pending, revoked, other, disconnected], ["youtube"])).toEqual([
      pending,
      other,
    ]);
  });
});
