import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSpaceSelection,
  createSpaceRpc,
  rpc,
  rpcForSpace,
  selectedSpaceId,
  selectSpace,
} from "./rpc.js";

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

describe("shell RPC space isolation", () => {
  it.each(["space-a", null])(
    "keeps async follow-up requests in the original space %s after selection changes",
    async (originalSpace) => {
      let selected = originalSpace;
      vi.stubGlobal("window", {
        location: { origin: "https://example.test", pathname: "/app" },
        localStorage: { getItem: () => selected },
      });
      const fetch = vi.fn(async (_input: Request, _init: RequestInit) =>
        Response.json({ json: {} }),
      );
      vi.stubGlobal("fetch", fetch);
      const shellRpc = createSpaceRpc(selectedSpaceId());
      await shellRpc.me();
      selected = "space-b";
      // For example, an upload continues after reading a file or awaiting another RPC.
      await shellRpc.artifacts.create({
        botId: "bot-a",
        name: "example.txt",
        mimeType: "text/plain",
        contentBase64: "ZXhhbXBsZQ==",
      });
      await rpc.me();
      const headers = fetch.mock.calls.map((call) => {
        const init = call[1];
        return new Headers(init.headers).get("x-rakazo-space-id");
      });
      expect(headers).toEqual([originalSpace, originalSpace, "space-b"]);
    },
  );

  it.each([createSpaceRpc, rpcForSpace])(
    "honours a space a call names explicitly with %s",
    async (clientForSpace) => {
      vi.stubGlobal("window", {
        location: { origin: "https://example.test", pathname: "/app" },
        localStorage: { getItem: () => "space-a" },
      });
      const fetch = vi.fn(async (_input: Request, _init: RequestInit) =>
        Response.json({ json: {} }),
      );
      vi.stubGlobal("fetch", fetch);
      const shellRpc = clientForSpace("space-a");
      await shellRpc.me(undefined, { context: { spaceId: "space-b" } });
      await shellRpc.me(undefined, { context: { spaceId: null } });
      await shellRpc.me();
      const headers = fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get("x-rakazo-space-id"),
      );
      expect(headers).toEqual(["space-b", null, "space-a"]);
    },
  );
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
        return Response.json({ json: null });
      }),
    );
    return sent;
  }

  it("sends its own space whichever space is selected", async () => {
    const sent = stubSelection("space-selected");
    await rpcForSpace("space-other").usage.summary();
    await rpc.usage.summary();
    expect(sent).toEqual(["space-other", "space-selected"]);
  });

  it("reuses one client per space", () => {
    expect(rpcForSpace("space-a")).toBe(rpcForSpace("space-a"));
    expect(rpcForSpace("space-a")).not.toBe(rpcForSpace("space-b"));
  });
});
