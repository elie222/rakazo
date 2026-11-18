import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  catalogItemAccounts,
  connectCatalogItem,
  isCatalogItemConnected,
  nextCatalogAccountLabel,
  waitForConnection,
  waitForSignIn,
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

  it.each(["removed", "revoked"])("avoids collisions after an account is %s", (removed) => {
    const rows = [account("Gmail", "connected"), account("Gmail 3", "connected")];
    if (removed === "revoked") rows.push(account("Gmail 2", "revoked"));
    expect(nextCatalogAccountLabel(rows, item)).toBe("Gmail 4");
  });

  it.each([
    { rows: [account("Gmail", "pending")], expected: "Gmail 2" },
    {
      rows: [account("Gmail", "connected"), account("Gmail 2", "pending")],
      expected: "Gmail 3",
    },
    {
      rows: [
        account("Gmail", "connected"),
        account("Gmail 4", "connected"),
        account("Gmail 3", "pending"),
      ],
      expected: "Gmail 5",
    },
  ])("skips occupied live account names: $expected", ({ rows, expected }) => {
    expect(nextCatalogAccountLabel(rows, item)).toBe(expected);
    expect(nextCatalogAccountLabel([...rows].reverse(), item)).toBe(expected);
  });

  it("checks display names rather than account IDs", () => {
    const rows = [{ ...account("stable-id", "connected"), displayName: "Gmail 2" }];
    expect(nextCatalogAccountLabel(rows, item)).toBe("Gmail 3");
  });

  it("does not reserve names from inactive accounts or other catalog apps", () => {
    const rows = [
      account("Gmail", "connected"),
      account("Gmail 2", "revoked"),
      account("Gmail 2", "error"),
      account("Gmail 2", "connected", "slack"),
      { ...account("Gmail 2", "connected"), connectorId: "pipedream" },
    ];
    expect(nextCatalogAccountLabel(rows, item)).toBe("Gmail 2");
  });

  it("passes an unoccupied default name to the connection request", async () => {
    const begin = vi.fn().mockResolvedValue({ connectionId: "new", authorizationUrl: null });
    await connectCatalogItem(
      { ...item, noAuth: true },
      [account("Gmail", "connected"), account("Gmail 3", "connected")],
      { begin, complete: vi.fn(), openUrl: vi.fn(), signal: new AbortController().signal },
    );
    expect(begin).toHaveBeenCalledWith({
      connectorId: item.connectorId,
      provider: item.slug,
      displayName: "Gmail 4",
    });
  });

  it("opens authorization and resolves once the connection completes", async () => {
    const openUrl = vi.fn();
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("not yet"))
      .mockResolvedValueOnce(account("new", "connected"));
    vi.useFakeTimers();
    let result: ReturnType<typeof connectCatalogItem>;
    try {
      result = connectCatalogItem(item, [], {
        begin: async () => ({ connectionId: "new", authorizationUrl: "https://auth.example.test" }),
        complete,
        openUrl,
        signal: new AbortController().signal,
      });
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
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

describe("waitForConnection", () => {
  const options = () => ({ signal: new AbortController().signal, attempts: 60 });

  it("stops polling once a newer attempt revoked the connection", async () => {
    const complete = vi.fn().mockResolvedValue(account("old", "revoked"));
    await expect(waitForConnection("old", complete, options())).resolves.toEqual({
      status: "aborted",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the connection no longer exists", async () => {
    const missing = Object.assign(new Error("Resource not found"), {
      status: 404,
      code: "NOT_FOUND",
    });
    const complete = vi.fn().mockRejectedValue(missing);
    await expect(waitForConnection("gone", complete, options())).resolves.toEqual({
      status: "aborted",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient failure", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }))
      // A proxy's bare 404 is not the server saying the connection is gone.
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
      .mockResolvedValueOnce(account("new", "pending"))
      .mockResolvedValueOnce(account("new", "connected"));
    vi.useFakeTimers();
    let result: ReturnType<typeof waitForConnection>;
    try {
      result = waitForConnection("new", complete, options());
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    expect(await result).toEqual({ status: "connected", row: account("new", "connected") });
    expect(complete).toHaveBeenCalledTimes(4);
  });
});

describe("waitForSignIn", () => {
  it("reads a slow sign-in again when the person comes back, not on a timer", async () => {
    let finished = false;
    const complete = vi.fn(async () => account("slow", finished ? "connected" : "pending"));
    const onSlow = vi.fn();
    const stop = vi.fn();
    let back = () => {};
    vi.useFakeTimers();
    try {
      const result = waitForSignIn("slow", complete, {
        signal: new AbortController().signal,
        onSlow,
        whenBack: (read) => {
          back = read;
          return stop;
        },
      });
      await vi.runAllTimersAsync();
      expect(onSlow).toHaveBeenCalledTimes(1);
      const polled = complete.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(complete).toHaveBeenCalledTimes(polled);
      back();
      await vi.runAllTimersAsync();
      expect(stop).not.toHaveBeenCalled();
      finished = true;
      back();
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ status: "connected", row: account("slow", "connected") });
    } finally {
      vi.useRealTimers();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not lose a finished sign-in to one failed read on return", async () => {
    let back = () => {};
    let returned = false;
    const complete = vi.fn(async () => {
      if (!returned) return account("slow", "pending");
      if (complete.mock.calls.length % 2 === 0) throw new Error("Unavailable");
      return account("slow", "connected");
    });
    vi.useFakeTimers();
    try {
      const result = waitForSignIn("slow", complete, {
        signal: new AbortController().signal,
        onSlow: () => {},
        whenBack: (read) => {
          back = read;
          return () => {};
        },
      });
      await vi.runAllTimersAsync();
      returned = true;
      back();
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ status: "connected", row: account("slow", "connected") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops watching a slow sign-in once a newer attempt takes its place", async () => {
    const controller = new AbortController();
    const stop = vi.fn();
    vi.useFakeTimers();
    try {
      const result = waitForSignIn("old", vi.fn().mockResolvedValue(account("old", "pending")), {
        signal: controller.signal,
        onSlow: () => {},
        whenBack: () => stop,
      });
      await vi.runAllTimersAsync();
      controller.abort();
      expect(await result).toEqual({ status: "aborted" });
    } finally {
      vi.useRealTimers();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
