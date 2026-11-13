// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import type { MobileBot, MobileGroup } from "./mobile-types";
import { useThreadBots } from "./thread-bots";

const router = vi.hoisted(() => ({ setParams: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./saved-chats", () => ({ loadSavedInbox: vi.fn(async () => null) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const group = (id: string, name: string) => ({ id, name }) as MobileGroup;

describe("thread roster refresh", () => {
  let root: Root;
  let state: ReturnType<typeof useThreadBots>;
  const activeBotId = { current: undefined as string | undefined };
  function Thread(props: { groupId?: string; botId?: string; name?: string }) {
    activeBotId.current = props.botId;
    state = useThreadBots({ ...props, activeBotId });
    return null;
  }
  async function render(props = { groupId: "group-1", name: "Old name" }) {
    await act(async () => root.render(createElement(Thread, props)));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    vi.mocked(rpc).mockImplementation(async () => []);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("refreshes the group title and mention roster when returning from settings", async () => {
    let groups = [group("group-1", "Old name")];
    vi.mocked(rpc).mockImplementation(async (method) => (method === "groups/list" ? groups : []));
    await render();
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(state.mentionGroups).toEqual(groups);
    expect(router.setParams).not.toHaveBeenCalled();
    groups = [group("group-1", "New name")];
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(state.mentionGroups).toEqual(groups);
    expect(router.setParams).toHaveBeenCalledWith({ name: "New name" });
    const refresh = state.refreshMentionBots;
    await render({ groupId: "group-1", name: "New name" });
    expect(state.refreshMentionBots).toBe(refresh);
    router.setParams.mockClear();
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("keeps bot title refresh independent of a failed group request", async () => {
    const bots = [{ id: "bot-1", name: "Renamed bot" }] as MobileBot[];
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "bots/list") return bots;
      throw new Error("groups unavailable");
    });
    await act(async () => root.render(createElement(Thread, { botId: "bot-1", name: "Old bot" })));
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(state.mentionBots).toEqual(bots);
    expect(router.setParams).toHaveBeenCalledWith({ name: "Renamed bot" });
  });

  it("keeps a successful group roster if the next refresh fails", async () => {
    const groups = [group("group-1", "New name")];
    vi.mocked(rpc).mockImplementation(async (method) => (method === "groups/list" ? groups : []));
    await render();
    await act(async () => {
      await state.refreshMentionBots();
    });
    vi.mocked(rpc).mockRejectedValue(new Error("offline"));
    router.setParams.mockClear();
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(state.mentionGroups).toEqual(groups);
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("refreshes groups even when the bot request fails", async () => {
    vi.mocked(rpc).mockImplementation(async (method) => {
      if (method === "groups/list") return [group("group-1", "New name")];
      throw new Error("bots unavailable");
    });
    await render();
    await act(async () => {
      await state.refreshMentionBots();
    });
    expect(router.setParams).toHaveBeenCalledWith({ name: "New name" });
  });

  it("ignores an older successful response after a newer success", async () => {
    const older = deferred<MobileGroup[]>();
    const newer = deferred<MobileGroup[]>();
    const pending = [older, newer];
    vi.mocked(rpc).mockImplementation(async (method) =>
      method === "groups/list" ? pending.shift()!.promise : [],
    );
    await render();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = state.refreshMentionBots();
      second = state.refreshMentionBots();
    });
    await act(async () => {
      newer.resolve([group("group-1", "Newest")]);
      await second;
    });
    await act(async () => {
      older.resolve([group("group-1", "Stale")]);
      await first;
    });
    expect(state.mentionGroups).toEqual([group("group-1", "Newest")]);
    expect(router.setParams).toHaveBeenCalledTimes(1);
  });

  it("accepts an earlier success when a later refresh failed", async () => {
    const older = deferred<MobileGroup[]>();
    const newer = deferred<MobileGroup[]>();
    const pending = [older, newer];
    vi.mocked(rpc).mockImplementation(async (method) =>
      method === "groups/list" ? pending.shift()!.promise : [],
    );
    await render();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = state.refreshMentionBots();
      second = state.refreshMentionBots();
    });
    await act(async () => {
      newer.reject(new Error("offline"));
      await second;
    });
    await act(async () => {
      older.resolve([group("group-1", "Saved")]);
      await first;
    });
    expect(state.mentionGroups).toEqual([group("group-1", "Saved")]);
    expect(router.setParams).toHaveBeenCalledWith({ name: "Saved" });
  });

  it.each(["switch", "unmount"])("ignores a late group response after %s", async (action) => {
    const pending = deferred<MobileGroup[]>();
    vi.mocked(rpc).mockImplementation(async (method) =>
      method === "groups/list" ? pending.promise : [],
    );
    await render();
    let refresh!: Promise<void>;
    act(() => {
      refresh = state.refreshMentionBots();
    });
    if (action === "switch") await render({ groupId: "group-2", name: "Other" });
    else {
      act(() => root.unmount());
      root = createRoot(document.createElement("div"));
    }
    await act(async () => {
      pending.resolve([group("group-1", "Late")]);
      await refresh;
    });
    expect(router.setParams).not.toHaveBeenCalled();
  });
});
