import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSpaceSelection, rpc, rpcForSpace, selectedSpaceId, selectSpace } from "./rpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("space selection storage", () => {
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("rakazo:space-id", "space-support");
  });
});

describe("space-bound clients", () => {
  function stubSelection(selected: string) {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? selected : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const sent: Array<string | null> = [];
    vi.stubGlobal("window", {
      localStorage,
      location: { origin: "http://test", pathname: "/app" },
    });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request, init?: RequestInit) => {
        sent.push(new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"));
        return new Response(JSON.stringify({ json: null }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return sent;
  }

  it("sends its own space whichever space is selected", async () => {
    const sent = stubSelection("space-selected");
    await rpcForSpace("space-other")
      .usage.summary()
      .catch(() => undefined);
    await rpc.usage.summary().catch(() => undefined);
    expect(sent).toEqual(["space-other", "space-selected"]);
  });

  it("reuses one client per space", () => {
    expect(rpcForSpace("space-a")).toBe(rpcForSpace("space-a"));
    expect(rpcForSpace("space-a")).not.toBe(rpcForSpace("space-b"));
  });
});
