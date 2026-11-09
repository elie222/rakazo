// @vitest-environment jsdom

import type { ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { runThreadSubscription } from "@rakazo/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query";
import { useThreadSync } from "./use-thread-sync";

vi.mock("@rakazo/core", async (original) => ({
  ...(await original<typeof import("@rakazo/core")>()),
  runThreadSubscription: vi.fn(async () => {}),
}));
vi.mock("../../lib/query", () => ({
  queryClient: {
    getQueryData: vi.fn(() => undefined),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => {}),
  },
}));
vi.mock("@rakazo/core/query", () => ({ fetchFresh: vi.fn(async () => []) }));

const ref = <T,>(current: T) => ({ current });
const flush = () => act(async () => {});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syncInput({
  inGroup,
  get,
  refreshBots = vi.fn(async () => {}),
  commitSnapshot,
  bot = { status: "idle", threadStatus: "idle" },
}: {
  inGroup: boolean;
  get: () => Promise<ThreadSnapshot>;
  refreshBots?: () => Promise<void>;
  commitSnapshot: (next: ThreadSnapshot | null) => void;
  bot?: { status: string; threadStatus?: string };
}) {
  return {
    rpc: { threads: { get } },
    queries: {
      threads: { get: { queryKey: vi.fn(() => ["thread"]) } },
      routines: { list: { queryOptions: vi.fn() }, history: { key: vi.fn(() => ["history"]) } },
      skills: { list: { queryOptions: vi.fn() } },
    },
    thread: {
      snapshot: null,
      snapshotRef: ref(null),
      commitSnapshot,
      updateSnapshot: vi.fn(),
      setRoutines: vi.fn(),
      setRoutinesBotId: vi.fn(),
      setTaughtSkills: vi.fn(),
      setTaughtSkillsBotId: vi.fn(),
      bootstrappedThread: ref(null),
      expandedHistoryThread: ref(null),
      historyEpoch: ref(0),
      messageScroll: ref(null),
      pinnedAroundRef: ref(null),
      resetHistory: vi.fn(),
    },
    computerState: {
      computerRef: ref(null),
      commitComputer: vi.fn(),
      cacheComputerFor: vi.fn(),
      showCachedComputer: vi.fn(),
      computerOpenRef: ref(false),
      computerBotIdRef: ref(null),
      refreshComputerScreen: vi.fn(async () => {}),
    },
    active: inGroup ? undefined : { id: "bot-1", name: "Bot", ...bot },
    activeGroup: inGroup ? { id: "group-1", name: "Group" } : undefined,
    inGroup,
    groupId: inGroup ? "group-1" : undefined,
    activeBotId: ref(inGroup ? undefined : "bot-1"),
    activeGroupId: ref(inGroup ? "group-1" : undefined),
    botsRef: ref([]),
    searchParamsRef: ref(new URLSearchParams()),
    refreshBots,
    notifyBrowserForEvent: vi.fn(),
    markBotReadIfVisible: vi.fn(),
    markGroupReadOnReply: vi.fn(),
    meId: "user-1",
  } as unknown as Parameters<typeof useThreadSync>[0];
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "coalesces real %s group event callbacks and drops queued work on leave",
  async (inGroup) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const snapshot = {
      threadId: "thread-1",
      cursor: 1,
      messages: [],
      run: null,
    } as unknown as ThreadSnapshot;
    const reads = [deferred<ThreadSnapshot>(), deferred<ThreadSnapshot>()];
    const get = vi.fn(() => reads[get.mock.calls.length - 1]!.promise);
    const roster = deferred<void>();
    const refreshBots = vi.fn(() => roster.promise);
    const commitSnapshot = vi.fn();
    const input = syncInput({ inGroup, get, refreshBots, commitSnapshot });
    function Probe() {
      useThreadSync(input);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const subscription = vi.mocked(runThreadSubscription).mock.calls[0]![0];
    const event = { type: "run.completed", payload: {}, runId: "run-1" } as ProductEvent;
    const deliver = () => subscription.onEvent(event, snapshot);
    deliver();
    await flush();
    for (let i = 0; i < 100; i++) deliver();
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(refreshBots).toHaveBeenCalledTimes(1);
    reads[0]!.resolve(snapshot);
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(commitSnapshot).toHaveBeenCalledWith(snapshot);
    // A pending trailing read from the burst must not run after teardown.
    act(() => root.unmount());
    reads[1]!.resolve(snapshot);
    roster.resolve();
    await flush();
    expect(refreshBots).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(subscription.signal.aborted).toBe(true);
  },
);

it.each([
  ["running", { status: "running" }, true],
  ["idle", null, true],
  ["running", null, false],
  ["idle", { status: "running" }, false],
])(
  "paints a %s bot's cached chat only when its run state still matches",
  async (botStatus, run, painted) => {
    await expectCachedPaint({ status: botStatus, threadStatus: botStatus }, { run }, painted);
  },
);

it("checks every active run in a cached chat, not just the primary one", async () => {
  await expectCachedPaint(
    { status: "idle", threadStatus: "idle" },
    { run: { status: "failed" }, activeRuns: [{ status: "running" }] },
    false,
  );
});

it("ignores the bot's work in other chats when judging its own cached chat", async () => {
  await expectCachedPaint({ status: "running", threadStatus: "idle" }, { run: null }, true);
});

it("paints the cached chat when the server reports no status for it", async () => {
  await expectCachedPaint({ status: "running" }, { run: null }, true);
});

async function expectCachedPaint(
  bot: { status: string; threadStatus?: string },
  runs: Record<string, unknown>,
  painted: boolean,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cached = { botId: "bot-1", messages: [], ...runs } as unknown as ThreadSnapshot;
  vi.mocked(queryClient.getQueryData).mockReturnValueOnce(cached);
  const commitSnapshot = vi.fn();
  const input = syncInput({
    inGroup: false,
    get: () => new Promise<ThreadSnapshot>(() => {}),
    commitSnapshot,
    bot,
  });
  function Probe() {
    useThreadSync(input);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(commitSnapshot.mock.calls.some(([next]) => next === cached)).toBe(painted);
  act(() => root.unmount());
}

it("anchors Load earlier on the first visible row, not the whole height delta", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A fake scroller whose height can grow while the older page loads, the way
  // a streaming reply appends content at the bottom during the fetch.
  const height = { now: 1000 };
  const rowBelow = { offsetTop: 600, offsetHeight: 200, isConnected: true };
  const scroller = {
    scrollTop: 500,
    get scrollHeight() {
      return height.now;
    },
    querySelectorAll: (selector: string) => (selector === "[data-message-id]" ? [rowBelow] : []),
  };
  const page = { threadId: "thread-1", messages: [], olderCursor: null };
  const messages = vi.fn(async () => {
    // The reply grew 250px at the bottom while the older page was loading.
    height.now += 250;
    return page;
  });
  const snapshot = { botId: "bot-1", threadId: "thread-1", olderCursor: "cursor-1" };
  const input = syncInput({
    inGroup: false,
    get: () => new Promise<ThreadSnapshot>(() => {}),
    commitSnapshot: vi.fn(),
  });
  input.rpc = { threads: { get: input.rpc.threads.get, messages } } as never;
  input.thread = {
    ...input.thread,
    snapshot: snapshot as never,
    snapshotRef: ref(snapshot),
    updateSnapshot: vi.fn(() => {
      // Prepending the older page grows the content above the reader by 400px.
      height.now += 400;
      rowBelow.offsetTop += 400;
    }),
    messageScroll: ref(scroller),
  } as never;
  let controls!: ReturnType<typeof useThreadSync>;
  function Probe() {
    controls = useThreadSync(input);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));

  await act(async () => void (await controls.loadOlder()));
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  });

  // Only the prepended page (400px) may move the reader; the 250px appended
  // at the bottom during the fetch must not.
  expect(scroller.scrollTop).toBe(900);
  act(() => root.unmount());
});

it("snaps a remounted transcript to the end when the refresh lands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The reader is at the end of bot A when the refresh starts; the bot switch
  // to A remounts the transcript before the response arrives, detaching the
  // element the snap was queued against.
  const detached = {
    scrollTop: 900,
    scrollHeight: 1000,
    clientHeight: 100,
    isConnected: true,
  };
  const mounted = {
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 100,
    isConnected: true,
  };
  const held = ref<HTMLDivElement | null>(detached as unknown as HTMLDivElement);
  const snapshot = {
    botId: "bot-1",
    threadId: "thread-1",
    messages: [],
  } as unknown as ThreadSnapshot;
  const input = syncInput({
    inGroup: false,
    get: () => Promise.resolve(snapshot),
    commitSnapshot: vi.fn(),
  });
  input.thread = { ...input.thread, messageScroll: held } as never;
  let controls!: ReturnType<typeof useThreadSync>;
  function Probe() {
    controls = useThreadSync(input);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));

  // The switch remounts the transcript while the request is in flight: start
  // the refresh, swap the scroller before its continuation runs.
  const pending = controls.refreshThread("bot-1");
  detached.isConnected = false;
  held.current = mounted as unknown as HTMLDivElement;
  await act(async () => void (await pending));
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  });

  expect(mounted.scrollTop).toBe(1200);
  act(() => root.unmount());
});
