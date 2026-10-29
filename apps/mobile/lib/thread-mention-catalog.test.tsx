// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestContext } from "./api";
import { useThreadMentionCatalog } from "./thread-mention-catalog";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  capture: vi.fn(),
  apiBase: "https://api.test",
  spaceId: "space-a",
  generation: 1,
  listeners: new Set<() => void>(),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: state.capture,
  currentApiBase: () => state.apiBase,
  selectedSpaceId: () => state.spaceId,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  subscribeSessionGeneration: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));

const bots = Array.from({ length: 9 }, (_, index) => ({
  id: `bot-${index}`,
  name: `Bot ${index}`,
}));
type RoutineFixture = { id: string; botId: string; name: string; crons: string[] };
const routine = (botId: string) => ({ id: `routine-${botId}`, botId, name: botId, crons: [] });
const connection = {
  id: "connection-1",
  provider: "example",
  displayName: "Example account",
  status: "connected",
};
const catalogItem = {
  connectorId: "test",
  slug: "new-app",
  name: "New app",
  connected: false,
  noAuth: false,
};
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type RequestOptions = { signal: AbortSignal; requestContext: ApiRequestContext };

let root: Root;
let container: HTMLDivElement;
function Harness({ owner = "thread-a", roster = bots }: { owner?: string; roster?: typeof bots }) {
  const catalog = useThreadMentionCatalog(owner, roster);
  return (
    <>
      <button type="button" onClick={catalog.onMentionRequested}>
        Mentions
      </button>
      <output>
        {JSON.stringify({ routines: catalog.routines, connectors: catalog.connectors })}
      </output>
    </>
  );
}
async function render(owner = "thread-a", roster = bots) {
  await act(async () => root.render(<Harness owner={owner} roster={roster} />));
}
async function activate() {
  await act(async () => container.querySelector("button")!.click());
}
function visible() {
  return JSON.parse(container.querySelector("output")!.textContent!);
}
function routineRequests() {
  return state.rpc.mock.calls.filter(([proc]) => proc === "routines/list");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.apiBase = "https://api.test";
  state.spaceId = "space-a";
  state.generation = 1;
  state.capture.mockReset().mockImplementation(async () => ({
    apiBase: state.apiBase,
    sessionGeneration: state.generation,
    headers: { authorization: "Bearer account-a", "x-rakazo-space-id": state.spaceId },
  }));
  state.rpc.mockReset().mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("screen-owned mention catalog", () => {
  it("lazily loads a large roster with one batch and preserves roster and routine order", async () => {
    const roster = Array.from({ length: 100 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    state.rpc.mockImplementation(async (proc: string, body: { botIds: string[] }) =>
      proc === "routines/listForMentions"
        ? [...body.botIds].reverse().map((botId) => ({ botId, routines: [routine(botId)] }))
        : [],
    );
    await render("thread-a", roster);
    expect(state.rpc).not.toHaveBeenCalled();
    await activate();
    expect(state.rpc).toHaveBeenCalledTimes(3);
    expect(routineRequests()).toHaveLength(0);
    expect(visible().routines.map((row: RoutineFixture) => row.botId)).toEqual(
      roster.map((bot) => bot.id),
    );
    await activate();
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });
  it.each(["server", "session", "space"])(
    "starts no queued fallback after a %s change without a screen render",
    async (identity) => {
      const pendingBatch = deferred<unknown[]>();
      const pendingConnections = deferred<unknown[]>();
      state.rpc.mockImplementation((proc: string) =>
        proc === "routines/listForMentions" ? pendingBatch.promise : pendingConnections.promise,
      );
      await render();
      await activate();
      if (identity === "server") state.apiBase = "https://other-api.test";
      if (identity === "session") state.generation += 1;
      if (identity === "space") state.spaceId = "space-b";
      await act(async () => pendingBatch.resolve([]));
      expect(routineRequests()).toHaveLength(0);
      await act(async () => pendingConnections.resolve([]));
      expect(visible()).toEqual({ routines: [], connectors: [] });
    },
  );

  it("waits for first use, then refreshes with the roster without loading again on repeated use", async () => {
    await render("thread-a", []);
    await render("thread-a", bots.slice(0, 1));
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.capture).not.toHaveBeenCalled();
    await activate();
    expect(routineRequests()).toHaveLength(1);
    expect(state.rpc.mock.calls.map(([proc]) => proc)).toEqual([
      "connections/list",
      "connections/catalog",
      "routines/list",
    ]);
    await activate();
    expect(state.rpc).toHaveBeenCalledTimes(3);
    await render("thread-a", bots.slice(0, 2));
    expect(routineRequests()).toHaveLength(3);
    expect(state.capture).toHaveBeenCalledTimes(2);
    await render("thread-a", []);
    expect(visible()).toEqual({ routines: [], connectors: [] });
    expect(state.rpc).toHaveBeenCalledTimes(7);
  });

  it("can reactivate after a space change rolls back before the next render", async () => {
    const roster = bots.slice(0, 1);
    const pending = deferred<unknown[]>();
    state.rpc.mockReturnValue(pending.promise);
    await render("thread-a", roster);
    await activate();
    state.spaceId = "space-b";
    await act(async () => pending.resolve([]));
    state.spaceId = "space-a";
    state.rpc.mockImplementation(async (proc: string) =>
      proc === "routines/list" ? [routine("fresh")] : [],
    );
    await render("thread-a", roster);
    await activate();

    expect(routineRequests()).toHaveLength(2);
    expect(visible().routines).toMatchObject([{ id: "routine-fresh" }]);
  });

  it("clears published targets when a live space mismatch cancels a roster refresh", async () => {
    const roster = bots.slice(0, 1);
    const refreshedRoster = bots.slice(0, 2);
    state.rpc.mockImplementation(async (proc: string, body: { botId: string }) => {
      if (proc === "routines/list") return [routine(body.botId)];
      if (proc === "connections/list") return [connection];
      return [];
    });
    await render("thread-a", roster);
    await activate();
    expect(visible().routines).toHaveLength(1);
    expect(visible().connectors).toHaveLength(1);

    const pending = deferred<unknown[]>();
    state.rpc.mockReturnValue(pending.promise);
    await render("thread-a", refreshedRoster);
    expect(visible().routines).toHaveLength(1);
    state.spaceId = "space-b";
    await act(async () => pending.resolve([]));
    state.spaceId = "space-a";
    await render("thread-a", refreshedRoster);
    expect(visible()).toEqual({ routines: [], connectors: [] });
    expect(state.rpc).toHaveBeenCalledTimes(7);

    state.rpc.mockImplementation(async (proc: string, body: { botId: string }) =>
      proc === "routines/list" ? [routine(body.botId)] : [],
    );
    await activate();
    expect(visible().routines).toMatchObject([{ id: "routine-bot-0" }, { id: "routine-bot-1" }]);
    expect(state.rpc).toHaveBeenCalledTimes(11);
  });

  it("loads after activation even if the roster arrives later", async () => {
    await render("thread-a", []);
    await activate();
    expect(state.rpc).not.toHaveBeenCalled();
    await render("thread-a", bots.slice(0, 1));
    expect(routineRequests()).toHaveLength(1);
  });

  it("bounds routines to four in flight and publishes in roster order despite completion order", async () => {
    const pending = new Map<string, Deferred<RoutineFixture[]>>();
    let inFlight = 0;
    let peak = 0;
    state.rpc.mockImplementation((proc: string, body: { botId: string }) => {
      if (proc !== "routines/list") return Promise.resolve([]);
      const request = deferred<RoutineFixture[]>();
      pending.set(body.botId, request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return request.promise.finally(() => {
        inFlight -= 1;
      });
    });
    await render();
    await activate();
    expect(routineRequests()).toHaveLength(4);
    for (const index of [3, 1, 4, 0, 6, 5, 2, 8, 7]) {
      const botId = `bot-${index}`;
      expect(pending.has(botId)).toBe(true);
      await act(async () => pending.get(botId)!.resolve([routine(botId)]));
      expect(inFlight).toBeLessThanOrEqual(4);
    }
    expect(peak).toBe(4);
    expect(routineRequests()).toHaveLength(9);
    expect(visible().routines).toEqual(
      bots.map((bot) => ({ ...routine(bot.id), botName: bot.name })),
    );
    expect(state.capture).toHaveBeenCalledOnce();
    const options = state.rpc.mock.calls.map((call) => call[2] as RequestOptions);
    expect(options.every((option) => option.requestContext === options[0]!.requestContext)).toBe(
      true,
    );
    expect(options.every((option) => option.signal instanceof AbortSignal)).toBe(true);
  });

  it("keeps successful bot lists and preserves connected-first catalog mapping and deduplication", async () => {
    state.rpc.mockImplementation(async (proc: string, body: { botId?: string }) => {
      if (proc === "routines/list") {
        if (body.botId === "bot-0") throw new Error("Unavailable");
        return [routine(body.botId!)];
      }
      if (proc === "connections/list")
        return [connection, { ...connection, id: "pending", status: "pending" }];
      return [
        catalogItem,
        { ...catalogItem, slug: "EXAMPLE", name: "Duplicate provider" },
        { ...catalogItem, slug: "other", name: "EXAMPLE ACCOUNT" },
        { ...catalogItem, slug: "already-connected", connected: true },
        { ...catalogItem, slug: "no-auth", noAuth: true },
      ];
    });
    await render("thread-a", bots.slice(0, 2));
    await activate();
    expect(visible()).toEqual({
      routines: [{ ...routine("bot-1"), botName: "Bot 1" }],
      connectors: [
        {
          id: "connection-1",
          name: "Example account",
          authStatus: "connected",
          connectionId: "connection-1",
        },
        { id: "catalog:test:new-app", name: "New app", authStatus: "needs_auth" },
      ],
    });
  });

  it.each(["connections/list", "connections/catalog"])(
    "keeps the other connector result when %s fails",
    async (failed) => {
      state.rpc.mockImplementation(async (proc: string) => {
        if (proc === failed) throw new Error("Unavailable");
        if (proc === "connections/list") return [connection];
        if (proc === "connections/catalog") return [catalogItem];
        return [];
      });
      await render("thread-a", bots.slice(0, 1));
      await activate();
      expect(visible().connectors).toEqual(
        failed === "connections/list"
          ? [{ id: "catalog:test:new-app", name: "New app", authStatus: "needs_auth" }]
          : [
              {
                id: "connection-1",
                name: "Example account",
                authStatus: "connected",
                connectionId: "connection-1",
              },
            ],
      );
    },
  );

  it.each(["routines/list", "connections/list", "connections/catalog", "context"])(
    "retries after %s fails on a later mention edit while retaining published results",
    async (failed) => {
      const roster = bots.slice(0, 2);
      let unavailable = true;
      state.capture.mockImplementation(async () => {
        if (failed === "context" && unavailable) throw new Error("Unavailable");
        return {
          apiBase: state.apiBase,
          sessionGeneration: state.generation,
          headers: { "x-rakazo-space-id": state.spaceId },
        };
      });
      state.rpc.mockImplementation(async (proc: string, body: { botId?: string }) => {
        if (proc === failed && unavailable && body.botId !== "bot-1")
          throw new Error("Unavailable");
        if (proc === "routines/list") return [routine(body.botId!)];
        if (proc === "connections/list") return [connection];
        return [catalogItem];
      });
      await render("thread-a", roster);
      await activate();
      const cached = visible();
      expect(state.capture).toHaveBeenCalledOnce();
      const capture = deferred<ApiRequestContext>();
      state.capture.mockReturnValueOnce(capture.promise);
      unavailable = false;
      await activate();
      expect(visible()).toEqual(cached);
      await act(async () =>
        capture.resolve({
          apiBase: state.apiBase,
          sessionGeneration: state.generation,
          headers: { "x-rakazo-space-id": state.spaceId },
        }),
      );
      expect(visible().routines).toHaveLength(2);
      expect(visible().connectors).toHaveLength(2);
      const calls = state.rpc.mock.calls.length;
      await activate();
      expect(state.rpc).toHaveBeenCalledTimes(calls);
    },
  );

  it("aborts invalidated loads, ignores their late responses and stops launching queued bots", async () => {
    const old = deferred<RoutineFixture[]>();
    state.rpc.mockReturnValue(old.promise);
    await render();
    await activate();
    const oldOptions = state.rpc.mock.calls.map((call) => call[2] as RequestOptions);
    expect(routineRequests()).toHaveLength(0);
    expect(
      state.rpc.mock.calls.filter(([proc]) => proc === "routines/listForMentions"),
    ).toHaveLength(1);
    await render("thread-a", [bots[8]!]);
    expect(oldOptions.every((option) => option.signal.aborted)).toBe(true);
    state.rpc.mockResolvedValue([]);
    await render("thread-a", [bots[7]!]);
    await act(async () => old.resolve([routine("stale")]));
    expect(routineRequests().map((call) => call[1].botId)).toEqual(["bot-8", "bot-7"]);
    expect(visible()).toEqual({ routines: [], connectors: [] });
  });

  it("never restores an old catalog when an activated target switches away and back", async () => {
    const old = deferred<RoutineFixture[]>();
    state.rpc.mockReturnValue(old.promise);
    await render("thread-a", bots.slice(0, 1));
    await activate();
    await render("thread-b", bots.slice(0, 1));
    await render("thread-a", bots.slice(0, 1));
    expect(state.rpc).toHaveBeenCalledTimes(3);
    state.rpc.mockResolvedValue([]);
    await activate();
    await act(async () => old.resolve([routine("stale")]));
    expect(state.rpc).toHaveBeenCalledTimes(6);
    expect(visible()).toEqual({ routines: [], connectors: [] });
  });

  it.each(["target", "account", "session", "server", "space"])(
    "requires fresh activation after %s identity changes, including switching back",
    async (identity) => {
      await render("account-a:thread-a", bots.slice(0, 1));
      await activate();
      const options = state.rpc.mock.calls[0]![2] as RequestOptions;
      const calls = state.rpc.mock.calls.length;
      let owner = "account-a:thread-a";
      if (identity === "target") owner = "account-a:thread-b";
      if (identity === "account") owner = "account-b:thread-a";
      if (identity === "session") state.generation += 1;
      if (identity === "server") state.apiBase = "https://other.test";
      if (identity === "space") state.spaceId = "space-b";
      await render(owner, bots.slice(0, 1));
      expect(options.signal.aborted).toBe(true);
      expect(state.rpc).toHaveBeenCalledTimes(calls);
      expect(visible()).toEqual({ routines: [], connectors: [] });
      state.generation = 1;
      state.apiBase = "https://api.test";
      state.spaceId = "space-a";
      await render("account-a:thread-a", bots.slice(0, 1));
      expect(state.rpc).toHaveBeenCalledTimes(calls);
      await activate();
      expect(state.rpc).toHaveBeenCalledTimes(calls + 3);
    },
  );

  it("aborts active requests on session invalidation without waiting for another screen render", async () => {
    const pending = deferred<unknown[]>();
    state.rpc.mockReturnValue(pending.promise);
    await render();
    await activate();
    const options = state.rpc.mock.calls.map((call) => call[2] as RequestOptions);
    await act(async () => {
      state.generation += 1;
      for (const listener of state.listeners) listener();
    });
    expect(options.every((option) => option.signal.aborted)).toBe(true);
    await act(async () => pending.resolve([]));
    expect(routineRequests()).toHaveLength(0);
    expect(
      state.rpc.mock.calls.filter(([proc]) => proc === "routines/listForMentions"),
    ).toHaveLength(1);
  });

  it("does not start requests when context capture crosses a space change", async () => {
    const capture = deferred<ApiRequestContext>();
    state.capture.mockReturnValue(capture.promise);
    await render();
    await activate();
    state.spaceId = "space-b";
    await act(async () =>
      capture.resolve({
        apiBase: state.apiBase,
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": "space-a" },
      }),
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each(["server", "session", "space"])(
    "allows fresh activation after capturing a mismatched %s context",
    async (identity) => {
      const roster = bots.slice(0, 1);
      state.capture.mockResolvedValueOnce({
        apiBase: identity === "server" ? "https://other.test" : state.apiBase,
        sessionGeneration: identity === "session" ? 2 : state.generation,
        headers: {
          "x-rakazo-space-id": identity === "space" ? "space-b" : state.spaceId,
        },
      });
      await render("thread-a", roster);
      await activate();
      expect(state.rpc).not.toHaveBeenCalled();
      expect(visible()).toEqual({ routines: [], connectors: [] });
      await render("thread-a", roster);
      expect(state.capture).toHaveBeenCalledOnce();

      state.rpc.mockImplementation(async (proc: string) =>
        proc === "routines/list" ? [routine("fresh")] : [],
      );
      await activate();
      expect(state.capture).toHaveBeenCalledTimes(2);
      expect(routineRequests()).toHaveLength(1);
      expect(visible().routines).toMatchObject([{ id: "routine-fresh" }]);
      await activate();
      expect(state.rpc).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["roster", "target"])(
    "keeps the current activation when an obsolete %s load captures a mismatched context",
    async (change) => {
      const capture = deferred<ApiRequestContext>();
      state.capture.mockReturnValueOnce(capture.promise);
      state.rpc.mockImplementation(async (proc: string, body: { botId: string }) =>
        proc === "routines/list" ? [routine(body.botId)] : [],
      );
      const roster = bots.slice(0, 1);
      await render("thread-a", roster);
      await activate();
      if (change === "target") {
        await render("thread-b", roster);
        await render("thread-a", roster);
        expect(state.rpc).not.toHaveBeenCalled();
        await activate();
      } else {
        await render("thread-a", [bots[1]!]);
      }
      const fresh = visible();
      expect(fresh.routines).toMatchObject([
        { id: change === "target" ? "routine-bot-0" : "routine-bot-1" },
      ]);
      await act(async () =>
        capture.resolve({
          apiBase: state.apiBase,
          sessionGeneration: state.generation,
          headers: { "x-rakazo-space-id": "space-b" },
        }),
      );
      expect(visible()).toEqual(fresh);
      await activate();
      expect(state.capture).toHaveBeenCalledTimes(2);
      expect(state.rpc).toHaveBeenCalledTimes(3);
    },
  );

  it("does not start requests after unmount while capturing context", async () => {
    const capture = deferred<ApiRequestContext>();
    state.capture.mockReturnValue(capture.promise);
    await render();
    await activate();
    await act(async () => root.render(null));
    await act(async () =>
      capture.resolve({
        apiBase: state.apiBase,
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": "space-a" },
      }),
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("aborts in-flight requests and launches no remaining bots after unmount", async () => {
    const pending = deferred<unknown[]>();
    state.rpc.mockReturnValue(pending.promise);
    await render();
    await activate();
    const options = state.rpc.mock.calls.map((call) => call[2] as RequestOptions);
    await act(async () => root.render(null));
    expect(options.every((option) => option.signal.aborted)).toBe(true);
    await act(async () => pending.resolve([]));
    expect(routineRequests()).toHaveLength(0);
    expect(
      state.rpc.mock.calls.filter(([proc]) => proc === "routines/listForMentions"),
    ).toHaveLength(1);
  });
});
