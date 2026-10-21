import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  catalogItemAccounts,
  connectCatalogItem,
  isCatalogItemConnected,
  nextCatalogAccountLabel,
} from "./connection-catalog.js";

const item: ConnectionCatalogItem = {
  connectorId: "composio",
  slug: "gmail",
  name: "Gmail",
  logo: null,
  connected: false,
  noAuth: false,
};

function account(id: string, status: Connection["status"], provider = "gmail") {
  return { id, connectorId: "composio", provider, status, displayName: id } as Connection;
}

describe("connection catalog", () => {
  it("counts only this app's live accounts", () => {
    const rows = [
      account("a", "connected"),
      account("b", "pending"),
      account("c", "revoked" as Connection["status"]),
      account("d", "connected", "slack"),
    ];
    expect(catalogItemAccounts(rows, item).map((row) => row.id)).toEqual(["a", "b"]);
    expect(isCatalogItemConnected(rows, item)).toBe(true);
    expect(isCatalogItemConnected([account("b", "pending")], item)).toBe(false);
  });

  it("numbers additional accounts", () => {
    expect(nextCatalogAccountLabel([], item)).toBe("Gmail");
    expect(nextCatalogAccountLabel([account("a", "connected")], item)).toBe("Gmail 2");
  });

  it("opens authorization and resolves once the connection completes", async () => {
    const openUrl = vi.fn();
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("not yet"))
      .mockResolvedValueOnce(account("new", "connected"));
    vi.useFakeTimers();
    const result = connectCatalogItem(item, [], {
      begin: async () => ({ connectionId: "new", authorizationUrl: "https://auth.example.test" }),
      complete,
      openUrl,
      signal: new AbortController().signal,
    });
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(openUrl).toHaveBeenCalledWith("https://auth.example.test");
    expect(await result).toEqual({ status: "connected", row: account("new", "connected") });
  });

  it("skips polling for apps that need no authorization", async () => {
    const complete = vi.fn();
    const result = await connectCatalogItem({ ...item, noAuth: true }, [], {
      begin: async () => ({ connectionId: "new", authorizationUrl: null }),
      complete,
      openUrl: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "connected" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("stops when the attempt is superseded", async () => {
    const controller = new AbortController();
    const result = await connectCatalogItem(item, [], {
      begin: async () => {
        controller.abort();
        return { connectionId: "new", authorizationUrl: null };
      },
      complete: vi.fn(),
      openUrl: vi.fn(),
      signal: controller.signal,
    });
    expect(result).toEqual({ status: "aborted" });
  });
});
