import { describe, expect, it } from "vitest";
import { selectRunConnections } from "./executor.js";

describe("run connection selection", () => {
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
