// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ChatAlert, ThreadSnapshot } from "@rakazo/contracts";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/query/rpc";
import { useBrowserNotifications } from "./use-browser-notifications";

type Frame = { type: "alert" | "roster" | "heartbeat"; alert?: ChatAlert };

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let streams: Array<{ push: (frame: Frame) => void; fail: (error: unknown) => void }>;
let signals: AbortSignal[];
let focused: boolean;
let visible: boolean;
let openChat: ReturnType<typeof vi.fn<(chat: Pick<ChatAlert, "botId" | "groupId">) => void>>;
let root: Root;
let hook: ReturnType<typeof useBrowserNotifications>;

function stream(): AsyncIterable<Frame> {
  const queue: Frame[] = [];
  let failure: unknown;
  let wake: Deferred | undefined;
  streams.push({
    push: (frame) => {
      queue.push(frame);
      wake?.resolve();
    },
    fail: (error) => {
      failure = error;
      wake?.resolve();
    },
  });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        wake = deferred();
        await wake.promise;
      }
    },
  };
}

const rpc = {
  notifications: {
    subscribe: (_input: undefined, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return Promise.resolve(stream());
    },
  },
} as unknown as Pick<RpcClient, "notifications">;

const noBots: Bot[] = [];
const bots = [{ id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot];
const groups: Array<{ id: string; snoozedUntil?: string | null }> = [{ id: "group-g" }];
const snapshotRef: { current: ThreadSnapshot | null } = { current: null };
const roster = { changed: vi.fn() };

function setLiveSnapshot(
  threadId: string,
  runs: Array<{ id: string; userId?: string; status?: string }>,
  messages: Array<{ id: string; blocks: Array<Record<string, unknown>> }> = [],
) {
  snapshotRef.current = {
    threadId,
    activeRuns: runs.map((run) => ({
      id: run.id,
      botId: "bot-b",
      status: run.status ?? "running",
      userId: run.userId,
    })),
    messages,
  } as unknown as ThreadSnapshot;
}

type HarnessProps = { botId?: string; groupId?: string; notificationSounds?: boolean };

function Harness({ botId, groupId, notificationSounds }: HarnessProps) {
  hook = useBrowserNotifications(
    noBots,
    { current: bots },
    {
      rpc,
      activeBotId: { current: botId },
      activeGroupId: { current: groupId },
      openChat,
      notificationSounds,
      meId: "user-1",
      groupsRef: { current: groups },
      snapshotRef,
      roster,
    },
  );
  return null;
}

function reply(id: string, blocks: Array<Record<string, unknown>>, threadId = "thread-b") {
  return {
    id,
    type: "thread.message.created" as const,
    threadId,
    seq: 5,
    botId: "bot-b",
    payload: { role: "bot" as const, blocks },
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function open(chat: HarnessProps) {
  act(() => root.render(<Harness {...chat} />));
  await flush();
}

async function send(alert: Partial<ChatAlert>) {
  streams.at(-1)!.push({
    type: "alert",
    alert: {
      kind: "completion",
      title: "Scout finished",
      body: "The report is ready.",
      spaceId: "space-1",
      botId: "bot-b",
      threadId: "thread-b",
      ...alert,
    },
  });
  await flush();
}

const shown = () => FakeNotification.shown.map((n) => [n.title, n.options.body, n.options.tag]);

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", FakeNotification);
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
  groups[0] = { id: "group-g" };
  snapshotRef.current = null;
  streams = [];
  signals = [];
  focused = true;
  visible = true;
  openChat = vi.fn<(chat: Pick<ChatAlert, "botId" | "groupId">) => void>();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBrowserNotifications chat alerts", () => {
  it("keeps desktop alerts silent by default", async () => {
    vi.stubGlobal("rakazoDesktop", {});
    await open({ botId: "bot-a" });
    await send({ kind: "help" });
    expect(FakeNotification.shown[0]?.options.silent).toBe(true);
  });

  it("plays only desktop attention alerts after the preference changes", async () => {
    vi.stubGlobal("rakazoDesktop", {});
    await open({ botId: "bot-a" });
    await open({ botId: "bot-a", notificationSounds: true });
    await send({ kind: "completion" });
    await send({ kind: "takeover" });
    expect(FakeNotification.shown.map(({ options }) => options.silent)).toEqual([true, false]);
    expect(streams).toHaveLength(1);
  });

  it("lets the server alert sound for a backgrounded desktop's open chat", async () => {
    vi.stubGlobal("rakazoDesktop", {});
    visible = false;
    await open({ botId: "bot-b", notificationSounds: true });
    await send({ kind: "failure" });
    expect(FakeNotification.shown[0]?.options).toMatchObject({ silent: false, tag: "thread-b" });
  });

  it("alerts for every kind in another chat while the app is focused", async () => {
    await open({ botId: "bot-a" });
    await send({});
    await send({ kind: "help", title: "Scout needs an answer", body: "Which repo?" });
    await send({ kind: "takeover", title: "Scout needs you on the screen", body: "Log in" });
    await send({ kind: "failure", title: "Scout failed", body: "Timed out" });
    await send({ kind: "completion", body: "Second reply." });
    expect(shown()).toEqual([
      ["Scout finished", "The report is ready.", "thread-b:completion"],
      ["Scout needs an answer", "Which repo?", "thread-b:help"],
      ["Scout needs you on the screen", "Log in", "thread-b:takeover"],
      ["Scout failed", "Timed out", "thread-b:failure"],
      ["Scout finished", "Second reply.", "thread-b:completion"],
    ]);
  });

  it("opens the alerted chat when clicked", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    await open({ botId: "bot-a" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    const [notification] = FakeNotification.shown;
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group-g" }));
    expect(notification!.closed).toBe(true);
  });

  it("leaves the open chat to its own stream", async () => {
    focused = false;
    await open({ botId: "bot-b" });
    await send({ kind: "completion" });
    await send({ kind: "failure" });
    await send({ kind: "help" });
    expect(shown()).toEqual([]);
  });

  it("treats a bot's alert from a group as another chat", async () => {
    await open({ botId: "bot-b" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toHaveLength(1);
  });

  it("skips the open group's alerts", async () => {
    focused = false;
    await open({ groupId: "group-g" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toEqual([]);
  });

  it("alerts for a takeover in the open chat only when the window is in the background", async () => {
    await open({ botId: "bot-b" });
    await send({ kind: "takeover" });
    expect(shown()).toEqual([]);
    visible = false;
    await send({ kind: "takeover" });
    expect(shown()).toHaveLength(1);
  });

  it("stays silent until notifications are allowed", async () => {
    FakeNotification.permission = "default";
    await open({ botId: "bot-a" });
    await send({});
    expect(shown()).toEqual([]);
  });

  it("reconnects after the stream drops", async () => {
    vi.useFakeTimers();
    await open({ botId: "bot-a" });
    streams[0]!.fail(new Error("network"));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(streams).toHaveLength(2);
    await send({});
    expect(shown()).toHaveLength(1);
  });

  it("passes roster signals on", async () => {
    roster.changed.mockClear();
    await open({ botId: "bot-a" });
    streams[0]!.push({ type: "roster" });
    streams[0]!.push({ type: "heartbeat" });
    await flush();
    expect(roster.changed).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([]);
  });

  it("opens the chat from its own finished-run notification", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    visible = false;
    await open({ groupId: "group-g" });
    const event = {
      id: "event-1",
      type: "thread.message.created",
      threadId: "thread-g",
      seq: 5,
      botId: "bot-b",
      payload: { role: "bot", blocks: [{ type: "text", text: "The report is ready." }] },
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-g", 4, true, "Scout", true, "group-g"));
    const [notification] = FakeNotification.shown;
    expect(shown()).toEqual([["Scout", "The report is ready.", "thread-g"]]);
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith({ botId: "bot-b", groupId: "group-g" });
    expect(notification!.closed).toBe(true);
  });

  it("announces a takeover once when the open chat is in the background", async () => {
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-takeover-card",
      type: "thread.message.created" as const,
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {
        role: "bot" as const,
        blocks: [
          {
            kind: "computer",
            state: TAKEOVER_COMPUTER_PENDING_STATE,
            text: "Sign in to continue.",
          },
        ],
      },
    };
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    await send({
      kind: "takeover",
      title: "Scout needs you on the screen",
      body: "Sign in to continue.",
    });
    // Same tag, so the browser shows the alert in place of the card: one notification.
    expect(shown().map(([, , tag]) => tag)).toEqual(["thread-b:takeover", "thread-b:takeover"]);
    expect(shown().at(-1)).toEqual([
      "Scout needs you on the screen",
      "Sign in to continue.",
      "thread-b:takeover",
    ]);
  });

  it("closes the open chat's notifications when the shell unmounts", async () => {
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-1",
      type: "run.failed",
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {},
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    act(() => root.unmount());
    expect(FakeNotification.shown[0]!.closed).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("preserves a question and reply while permission is pending", async () => {
    FakeNotification.permission = "default";
    visible = false;
    await open({ botId: "bot-b" });
    for (const event of [
      reply("ask-pending", [{ kind: "ask", text: "Which repo?", status: "pending" }]),
      reply("reply-pending", [{ kind: "text", text: "Saturday works." }]),
    ]) {
      act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    }
    expect(shown()).toEqual([]);
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown().map((notification) => notification[2])).toEqual(["thread-b:ask", "thread-b"]);
  });

  it("drops a notification held for permission when the shell unmounts first", async () => {
    FakeNotification.permission = "default";
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-1",
      type: "run.failed",
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {},
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    act(() => root.unmount());
    FakeNotification.permission = "granted";
    hook.flushPendingBrowserNotifications();
    expect(shown()).toEqual([]);
    root = createRoot(document.createElement("div"));
  });

  it("stays quiet for an ordinary reply in a snoozed open chat, and still announces a question", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const earlier = new Date(Date.now() - 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    groups[0] = { id: "group-g", snoozedUntil: later };
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        reply("plain-bot", [{ kind: "text", text: "The report is ready." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        reply("plain-group", [{ kind: "text", text: "Saturday works." }], "thread-g"),
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([]);
    act(() =>
      hook.notifyBrowserForEvent(
        reply("ask-bot", [{ kind: "ask", text: "Which repo?", status: "pending" }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        reply("ask-group", [{ kind: "ask", text: "Which day?", status: "pending" }], "thread-g"),
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown().map((row) => row[2])).toEqual(["thread-b:ask", "thread-g:ask"]);
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: earlier } as Bot;
    groups[0] = { id: "group-g", snoozedUntil: earlier };
    act(() =>
      hook.notifyBrowserForEvent(
        reply("woke-bot", [{ kind: "text", text: "Awake again." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown().map((row) => row[1])).toContain("Awake again.");
  });

  it("drops a reply queued for permission when the chat is snoozed before permission arrives", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        reply("held", [{ kind: "text", text: "Still working." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("keeps a snoozed chat quiet for another member's ask or tool question, and for answered or expired questions", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const expired = new Date(Date.now() - 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [
      { id: "run-theirs", userId: "member-2" },
      { id: "run-mine", userId: "user-1" },
    ]);
    await open({ botId: "bot-b" });
    for (const event of [
      {
        ...reply("foreign-ask", [{ kind: "ask", text: "Buy the ticket?", status: "pending" }]),
        runId: "run-theirs",
      },
      {
        ...reply("foreign-tool-q", [
          {
            kind: "tool_question",
            question: { source: "Calendar", message: "Which slot?", fields: [] },
            status: "pending",
            expiresAt: later,
            publicKey: "key",
          },
        ]),
        runId: "run-theirs",
      },
      {
        ...reply("unknown-tool-q", [
          {
            kind: "tool_question",
            question: { source: "Calendar", message: "Which slot?", fields: [] },
            status: "pending",
            expiresAt: later,
            publicKey: "key",
          },
        ]),
        runId: "run-unknown",
      },
      {
        ...reply("answered-ask", [{ kind: "ask", text: "Already done", status: "answered" }]),
        runId: "run-mine",
      },
      {
        ...reply("expired-tool-q", [
          {
            kind: "tool_question",
            question: { source: "Calendar", message: "Too late", fields: [] },
            status: "pending",
            expiresAt: expired,
            publicKey: "key",
          },
        ]),
        runId: "run-mine",
      },
    ]) {
      act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    }
    expect(shown()).toEqual([]);
  });

  it("reads run ownership synchronously from the live snapshot during a stream burst without waiting for render", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    groups[0] = { id: "group-g", snoozedUntil: later };
    await open({ groupId: "group-g" });

    // Simulate run.started + card arriving in one stream burst before React re-renders.
    setLiveSnapshot("thread-g", [
      { id: "run-mine-burst", userId: "user-1" },
      { id: "run-theirs-burst", userId: "member-2" },
    ]);
    act(() => {
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "foreign-burst-ask",
            [{ kind: "ask", text: "Other member approval", status: "pending" }],
            "thread-g",
          ),
          runId: "run-theirs-burst",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "own-burst-tool-q",
            [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Pick a slot", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
            "thread-g",
          ),
          runId: "run-mine-burst",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
    });
    expect(shown()).toEqual([["Scout", "Message", "thread-g:ask"]]);
  });

  it("announces the viewer's own ask, a runless ask, and the viewer's own pending tool question in a snoozed chat", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply("own-ask", [{ kind: "ask", text: "Which repo?", status: "pending" }]),
          runId: "run-mine",
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        reply("bg-ask", [{ kind: "ask", text: "Approve deploy?", status: "pending" }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply("own-tool-q", [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Which slot?", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ]),
          runId: "run-mine",
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([
      ["Scout", "Which repo?", "thread-b:ask"],
      ["Scout", "Approve deploy?", "thread-b:ask"],
      ["Scout", "Message", "thread-b:ask"],
    ]);
  });

  it("does not let another member's tool question overwrite the viewer's queued ask before a snooze", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    groups[0] = { id: "group-g" };
    setLiveSnapshot("thread-g", [
      { id: "run-mine", userId: "user-1" },
      { id: "run-theirs", userId: "member-2" },
    ]);
    await open({ groupId: "group-g" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "own-queued-ask",
            [{ kind: "ask", text: "Approve my deploy?", status: "pending" }],
            "thread-g",
          ),
          runId: "run-mine",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "foreign-queued-tool-q",
            [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Other slot", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
            "thread-g",
          ),
          runId: "run-theirs",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    groups[0] = { id: "group-g", snoozedUntil: later };
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Approve my deploy?", "thread-g:ask"]]);
  });

  it("tracks run ownership from stream events during snapshot recovery when snapshotRef is null", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    groups[0] = { id: "group-g", snoozedUntil: later };
    snapshotRef.current = null;
    await open({ groupId: "group-g" });

    act(() => {
      hook.notifyBrowserForEvent(
        {
          id: "run-start-mine",
          type: "run.started",
          threadId: "thread-g",
          seq: 5,
          runId: "run-mine-head",
          botId: "bot-b",
          payload: { userId: "user-1" },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      hook.notifyBrowserForEvent(
        {
          id: "run-start-theirs",
          type: "run.started",
          threadId: "thread-g",
          seq: 6,
          runId: "run-theirs-head",
          botId: "bot-b",
          payload: { userId: "member-2" },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "foreign-head-ask",
            [{ kind: "ask", text: "Other member head approval", status: "pending" }],
            "thread-g",
          ),
          seq: 7,
          runId: "run-theirs-head",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "own-head-tool-q",
            [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Pick a slot", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
            "thread-g",
          ),
          seq: 8,
          runId: "run-mine-head",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
    });
    expect(shown()).toEqual([["Scout", "Message", "thread-g:ask"]]);
  });

  it("does not let a background helper's ask overwrite the viewer's queued ask before run.waiting_input", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    groups[0] = { id: "group-g" };
    setLiveSnapshot("thread-g", [{ id: "run-mine", userId: "user-1" }]);
    await open({ groupId: "group-g" });

    act(() => {
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "own-queued-ask-helper-race",
            [{ kind: "ask", text: "Approve my deploy?", status: "pending" }],
            "thread-g",
          ),
          seq: 5,
          runId: "run-mine",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      // Background helper emits thread.message.created before run.waiting_input identifies its owner.
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "helper-queued-ask",
            [{ kind: "ask", text: "Other member's helper ask", status: "pending" }],
            "thread-g",
          ),
          seq: 6,
          runId: "run-helper-theirs",
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      hook.notifyBrowserForEvent(
        {
          id: "helper-waiting",
          type: "run.waiting_input",
          threadId: "thread-g",
          seq: 7,
          runId: "run-helper-theirs",
          botId: "bot-b",
          payload: { userId: "member-2", trigger: "background_helper" },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
    });

    groups[0] = { id: "group-g", snoozedUntil: later };
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Approve my deploy?", "thread-g:ask"]]);
  });

  it("uses payload.runUserId to suppress a foreign helper ask immediately and deliver a viewer tool question during snapshot recovery", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    groups[0] = { id: "group-g", snoozedUntil: later };
    snapshotRef.current = null;
    await open({ groupId: "group-g" });

    act(() => {
      // Foreign background helper ask arrives before run.waiting_input, carrying runUserId on the card.
      hook.notifyBrowserForEvent(
        {
          ...reply(
            "foreign-helper-live-ask",
            [{ kind: "ask", text: "Other member helper approval", status: "pending" }],
            "thread-g",
          ),
          seq: 5,
          runId: "run-helper-live",
          payload: {
            role: "bot",
            blocks: [{ kind: "ask", text: "Other member helper approval", status: "pending" }],
            runUserId: "member-2",
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
      // Viewer's tool_question arrives after threads.head with no prior run.started and null snapshot.
      hook.notifyBrowserForEvent(
        {
          id: "own-recovery-tool-q",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 6,
          runId: "run-started-before-head",
          botId: "bot-b",
          payload: {
            role: "bot",
            runUserId: "user-1",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Pick a slot", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      );
    });
    expect(shown()).toEqual([["Scout", "Message", "thread-g:ask"]]);
  });

  it("delivers an already-answered card and keeps non-question or mixed queued alerts when thread.message.updated arrives", async () => {
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });

    // An already-answered Settings updated card must not be discarded as an expired question on flush.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "settings-updated-event",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 5,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            messageId: "msg-settings",
            role: "bot",
            blocks: [{ kind: "ask", text: "Settings updated", status: "answered" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Settings updated", "thread-b"]]);

    // Updating a skill draft or settling an ask in a mixed reply must not drop queued ordinary alerts.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    act(() => {
      hook.notifyBrowserForEvent(
        {
          id: "mixed-reply-event",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            messageId: "msg-mixed",
            role: "bot",
            blocks: [
              { kind: "text", text: "Saved the draft for you." },
              { kind: "ask", text: "Publish it?", status: "pending" },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      );
      hook.notifyBrowserForEvent(
        {
          id: "mixed-reply-updated",
          type: "thread.message.updated",
          threadId: "thread-b",
          seq: 7,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            messageId: "msg-mixed",
            role: "bot",
            blocks: [
              { kind: "text", text: "Saved the draft for you." },
              { kind: "ask", text: "Publish it?", status: "answered" },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      );
    });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Saved the draft for you.\nPublish it?", "thread-b"]]);
  });

  it("remembers run ownership across chat switches for mixed replies and drops a queued foreign ask when snoozed before permission", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-theirs", userId: "member-2" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply("foreign-nav", [
            { kind: "text", text: "Need approval." },
            { kind: "ask", text: "Approve refund?", status: "pending" },
          ]),
          runId: "run-theirs",
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    snapshotRef.current = null;
    await open({ botId: "bot-other" });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("drops a queued unknown-run ask when foreign ownership arrives before permission grant and the chat is snoozed", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", []);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          ...reply("late-foreign", [{ kind: "ask", text: "Deploy now?", status: "pending" }]),
          runId: "run-late-theirs",
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    setLiveSnapshot("thread-b", [{ id: "run-late-theirs", userId: "member-2" }]);
    await open({ botId: "bot-b" });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("delivers a queued viewer-owned tool question while the chat stays open, and drops cleared, left, expired, or settled cards on flush", async () => {
    vi.useFakeTimers();
    const baseNow = Date.now();
    vi.setSystemTime(baseNow);
    const soon = new Date(baseNow + 5_000).toISOString();
    const later = new Date(baseNow + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "tool-q-event",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-1",
            role: "bot",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Which slot?", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Message", "thread-b:ask"]]);

    // Switching away from the chat closes its thread subscription, so a queued ask is dropped
    // rather than risking a stale alert if answered elsewhere while away.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "ask-left-chat",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 7,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-left",
            role: "bot",
            blocks: [{ kind: "ask", text: "Still needed?", status: "pending" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() => hook.dropPendingQuestions("thread-b"));
    snapshotRef.current = null;
    await open({ botId: "bot-other" });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);

    // Clearing a thread invalidates its queued ask alerts.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() => {
      hook.notifyBrowserForEvent(
        {
          id: "ask-before-clear",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 8,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-clear",
            role: "bot",
            blocks: [{ kind: "ask", text: "Cleared ask?", status: "pending" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      );
      hook.notifyBrowserForEvent(
        {
          id: "thread-cleared-event",
          type: "thread.cleared",
          threadId: "thread-b",
          seq: 9,
          botId: "bot-b",
          payload: {},
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      );
    });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);

    // A queued tool question that expires before permission arrives is dropped even without a snooze.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "tool-q-expiring",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 10,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-expiring",
            role: "bot",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Soon expired", fields: [] },
                status: "pending",
                expiresAt: soon,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    vi.setSystemTime(baseNow + 10_000);
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);

    // A queued ask settled via snapshot refresh before permission arrives is discarded.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "ask-settle-event",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 11,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-2",
            role: "bot",
            blocks: [{ kind: "ask", text: "Proceed?", status: "pending" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    setLiveSnapshot(
      "thread-b",
      [],
      [{ id: "msg-2", blocks: [{ kind: "ask", text: "Proceed?", status: "answered" }] }],
    );
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("defers a legacy helper ask until run.waiting_input identifies the owner in a snoozed chat", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    groups[0] = { id: "group-g", snoozedUntil: later };
    setLiveSnapshot("thread-g", []);
    await open({ groupId: "group-g" });

    // Legacy worker omits payload.runUserId and sends the ask card before run.waiting_input.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-foreign-ask",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 5,
          runId: "run-helper-other",
          botId: "bot-b",
          payload: {
            id: "msg-foreign",
            role: "bot",
            blocks: [{ kind: "ask", text: "Other member approval?", status: "pending" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-own-ask",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 6,
          runId: "run-helper-mine",
          botId: "bot-b",
          payload: {
            id: "msg-mine",
            role: "bot",
            blocks: [{ kind: "ask", text: "My helper approval?", status: "pending" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([]);

    // Foreign ownership resolves: suppressed by snooze.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "wait-other",
          type: "run.waiting_input",
          threadId: "thread-g",
          seq: 7,
          runId: "run-helper-other",
          botId: "bot-b",
          payload: { userId: "member-2" },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([]);

    // Viewer ownership resolves: delivered immediately with :ask tag.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "wait-mine",
          type: "run.waiting_input",
          threadId: "thread-g",
          seq: 8,
          runId: "run-helper-mine",
          botId: "bot-b",
          payload: { userId: "user-1" },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([["Scout", "My helper approval?", "thread-g:ask"]]);
  });

  it("delivers a legacy tool question once snapshot recovery supplies the viewer as run owner", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    snapshotRef.current = null;
    await open({ botId: "bot-b" });

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-tool-q",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-recovered",
          botId: "bot-b",
          payload: {
            id: "msg-tq",
            role: "bot",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Pick a time", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([]);

    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 6,
      olderCursor: null,
      activeRuns: [{ id: "run-recovered", botId: "bot-b", status: "running", userId: "user-1" }],
      messages: [
        {
          id: "msg-tq",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Pick a time", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
      ],
    } as unknown as ThreadSnapshot;
    act(() => hook.reconcileSnapshot(snapshotRef.current));
    expect(shown()).toEqual([["Scout", "Message", "thread-b:ask"]]);
  });

  it("keeps the first of two parallel tool questions from one run when the second settles before permission", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });

    const makeToolQ = (id: string, msgId: string, seq: number, source: string) => ({
      id,
      type: "thread.message.created" as const,
      threadId: "thread-b",
      seq,
      runId: "run-mine",
      botId: "bot-b",
      payload: {
        id: msgId,
        role: "bot" as const,
        runUserId: "user-1",
        blocks: [
          {
            kind: "tool_question",
            question: { source, message: `Question from ${source}`, fields: [] },
            status: "pending",
            expiresAt: later,
            publicKey: "key",
          },
        ],
      },
    });

    act(() =>
      hook.notifyBrowserForEvent(
        makeToolQ("tq-1", "msg-tq-1", 5, "Calendar"),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        makeToolQ("tq-2", "msg-tq-2", 6, "Jira"),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "tq-2-settled",
          type: "thread.message.updated",
          threadId: "thread-b",
          seq: 7,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            messageId: "msg-tq-2",
            blocks: [{ kind: "tool_question", status: "answered" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Message", "thread-b:ask"]]);
  });

  it("drops a cleared queued ask on an authoritative empty snapshot while preserving older asks across paginated snapshots", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });

    // Paginated snapshot (olderCursor !== null) must not drop an older queued ask absent from the newest page.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "paged-ask",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 5,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-paged",
            role: "bot",
            runUserId: "user-1",
            blocks: [{ kind: "ask", text: "Still waiting?", status: "pending" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 25,
      olderCursor: 15,
      activeRuns: [{ id: "run-mine", botId: "bot-b", status: "waiting_input", userId: "user-1" }],
      messages: [{ id: "msg-newer", blocks: [{ kind: "text", text: "Later note" }] }],
    } as unknown as ThreadSnapshot;
    act(() => hook.reconcileSnapshot(snapshotRef.current));
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Still waiting?", "thread-b:ask"]]);

    // Authoritative empty snapshot (olderCursor === null, cursor >= seq) drops a cleared ask before thread.cleared replays.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "cleared-ask",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 30,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-cleared",
            role: "bot",
            runUserId: "user-1",
            blocks: [{ kind: "ask", text: "Cleared before replay?", status: "pending" }],
          },
        },
        "thread-b",
        25,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 31,
      olderCursor: null,
      activeRuns: [],
      messages: [],
    } as unknown as ThreadSnapshot;
    act(() => hook.reconcileSnapshot(snapshotRef.current));
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("keeps a pending-owner legacy ask across intermediate renders and ownerless live runs until ownership arrives", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    // Live UI snapshot has cursor already advanced by thread.message.created and an ownerless run stub.
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 5,
      olderCursor: null,
      activeRuns: [{ id: "run-legacy", botId: "bot-b", status: "running" }],
      messages: [
        { id: "msg-legacy", blocks: [{ kind: "ask", text: "Approve legacy?", status: "pending" }] },
      ],
    } as unknown as ThreadSnapshot;
    await open({ botId: "bot-b" });

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-ask-render",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 5,
          runId: "run-legacy",
          botId: "bot-b",
          payload: {
            id: "msg-legacy",
            role: "bot",
            blocks: [{ kind: "ask", text: "Approve legacy?", status: "pending" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    // Intermediate render between thread.message.created and run.waiting_input must NOT drop the ask.
    await open({ botId: "bot-b" });
    expect(shown()).toEqual([]);

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-wait",
          type: "run.waiting_input",
          threadId: "thread-b",
          seq: 6,
          runId: "run-legacy",
          botId: "bot-b",
          payload: { userId: "user-1" },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([["Scout", "Approve legacy?", "thread-b:ask"]]);
  });

  it("drops stopped-run questions (queued and replayed) when a fresh server snapshot omits the run", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-stopped", userId: "user-1" }]);
    await open({ botId: "bot-b" });

    // Queued tool question whose card remains marked pending after the run is stopped.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "queued-stopped-tq",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-stopped",
          botId: "bot-b",
          payload: {
            id: "msg-stopped-1",
            role: "bot",
            runUserId: "user-1",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Stopped queued", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    // Fresh raw server snapshot at cursor 10 omits run-stopped even though the card block is still pending.
    const rawSnap = {
      threadId: "thread-b",
      cursor: 10,
      olderCursor: null,
      activeRuns: [],
      messages: [
        {
          id: "msg-stopped-1",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Stopped queued", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
        {
          id: "msg-stopped-2",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Stopped replayed", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
      ],
    } as unknown as ThreadSnapshot;
    act(() => hook.reconcileSnapshot(rawSnap));

    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);

    // Replayed tool question first seen after rawSnap committed must also be suppressed.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "replayed-stopped-tq",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 8,
          runId: "run-stopped",
          botId: "bot-b",
          payload: {
            id: "msg-stopped-2",
            role: "bot",
            runUserId: "user-1",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Stopped replayed", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([]);
  });

  it("ignores search-jump UI snapshots when checking clears and trusts the raw server snapshot over expanded history", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    setLiveSnapshot("thread-b", [{ id: "run-mine", userId: "user-1" }]);
    await open({ botId: "bot-b" });

    // Queue an open ask at seq 20.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "open-ask-jump",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 20,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-open-20",
            role: "bot",
            runUserId: "user-1",
            blocks: [{ kind: "ask", text: "Still open?", status: "pending" }],
          },
        },
        "thread-b",
        10,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    // Search jump replaces UI snapshotRef with an older page whose olderCursor is null and omits msg-open-20.
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 20,
      olderCursor: null,
      activeRuns: [{ id: "run-mine", botId: "bot-b", status: "waiting_input", userId: "user-1" }],
      messages: [{ id: "msg-old-1", blocks: [{ kind: "text", text: "Old message" }] }],
    } as unknown as ThreadSnapshot;
    await open({ botId: "bot-b" });
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Still open?", "thread-b:ask"]]);

    // Conversely, when expanded history keeps a deleted ask in UI snapshotRef, raw threads.get drops it.
    FakeNotification.shown = [];
    FakeNotification.permission = "default";
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "cleared-in-expanded",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 25,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-cleared-25",
            role: "bot",
            runUserId: "user-1",
            blocks: [{ kind: "ask", text: "Deleted ask?", status: "pending" }],
          },
        },
        "thread-b",
        20,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    // UI snapshot retains msg-cleared-25 (expanded history), while raw server snapshot only has post-clear msg-30.
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 30,
      olderCursor: null,
      activeRuns: [{ id: "run-mine", botId: "bot-b", status: "waiting_input", userId: "user-1" }],
      messages: [
        {
          id: "msg-cleared-25",
          blocks: [{ kind: "ask", text: "Deleted ask?", status: "pending" }],
        },
        { id: "msg-post-clear-30", blocks: [{ kind: "text", text: "Fresh after clear" }] },
      ],
    } as unknown as ThreadSnapshot;
    act(() =>
      hook.reconcileSnapshot({
        threadId: "thread-b",
        cursor: 30,
        olderCursor: null,
        activeRuns: [{ id: "run-mine", botId: "bot-b", status: "waiting_input", userId: "user-1" }],
        messages: [
          { id: "msg-post-clear-30", blocks: [{ kind: "text", text: "Fresh after clear" }] },
        ],
      } as unknown as ThreadSnapshot),
    );
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("drops a queued tool question when a newer search jump shows it answered despite an older raw snapshot", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    const pendingSnap = {
      threadId: "thread-b",
      cursor: 6,
      olderCursor: null,
      activeRuns: [{ id: "run-mine", botId: "bot-b", status: "running", userId: "user-1" }],
      messages: [
        {
          id: "msg-tq-jump",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Pick a slot", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
      ],
    } as unknown as ThreadSnapshot;
    snapshotRef.current = pendingSnap;
    await open({ botId: "bot-b" });
    act(() => hook.reconcileSnapshot(pendingSnap));

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "tq-jump-evt",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-mine",
          botId: "bot-b",
          payload: {
            id: "msg-tq-jump",
            role: "bot",
            runUserId: "user-1",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Pick a slot", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    // Same-chat search jump commits a newer around-page where msg-tq-jump is already answered while
    // the raw threads.get response still had cursor 6 with the card pending.
    snapshotRef.current = {
      threadId: "thread-b",
      cursor: 6,
      olderCursor: null,
      activeRuns: [{ id: "run-mine", botId: "bot-b", status: "running", userId: "user-1" }],
      messages: [
        {
          id: "msg-tq-jump",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Pick a slot", fields: [] },
              status: "answered",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
      ],
    } as unknown as ThreadSnapshot;
    act(() => hook.reconcileSnapshot(pendingSnap));

    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("drops a replayed expired tool question in an unsnoozed chat instead of alerting as a generic message", async () => {
    const expired = new Date(Date.now() - 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
    const rawSnap = {
      threadId: "thread-b",
      cursor: 10,
      olderCursor: null,
      activeRuns: [],
      messages: [
        {
          id: "msg-expired-tq",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Expired prompt", fields: [] },
              status: "expired",
              expiresAt: expired,
              publicKey: "key",
            },
          ],
        },
      ],
    } as unknown as ThreadSnapshot;
    snapshotRef.current = rawSnap;
    await open({ botId: "bot-b" });
    act(() => hook.reconcileSnapshot(rawSnap));

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "replayed-expired-tq",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-expired",
          botId: "bot-b",
          payload: {
            id: "msg-expired-tq",
            role: "bot",
            runUserId: "user-1",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Expired prompt", fields: [] },
                status: "pending",
                expiresAt: expired,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([]);
  });

  it("keeps the newest ordinary reply over an older queued foreign ask sharing the same tag on permission flush", async () => {
    FakeNotification.permission = "default";
    visible = false;
    groups[0] = { id: "group-g" };
    setLiveSnapshot("thread-g", [{ id: "run-other", userId: "user-2" }]);
    await open({ groupId: "group-g" });

    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "reply-1",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 5,
          runId: "run-other",
          botId: "bot-b",
          payload: {
            id: "msg-reply-1",
            role: "bot",
            blocks: [{ kind: "text", text: "First reply" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "foreign-ask",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 6,
          runId: "run-other",
          botId: "bot-b",
          payload: {
            id: "msg-foreign-ask",
            role: "bot",
            runUserId: "user-2",
            blocks: [{ kind: "ask", text: "Older foreign ask?", status: "pending" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "reply-2",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 7,
          runId: "run-other",
          botId: "bot-b",
          payload: {
            id: "msg-reply-2",
            role: "bot",
            blocks: [{ kind: "text", text: "Newest reply" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );

    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([["Scout", "Newest reply", "thread-g"]]);
  });

  it("drops an older pending-owner foreign question once a newer reply has already displayed on the same tag", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    visible = false;
    groups[0] = { id: "group-g" };
    snapshotRef.current = null;
    await open({ groupId: "group-g" });

    // Older legacy tool question without runUserId is held pending ownership.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "legacy-older-tq",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 6,
          runId: "run-other-legacy",
          botId: "bot-b",
          payload: {
            id: "msg-older-tq",
            role: "bot",
            blocks: [
              {
                kind: "tool_question",
                question: { source: "Calendar", message: "Older prompt", fields: [] },
                status: "pending",
                expiresAt: later,
                publicKey: "key",
              },
            ],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([]);

    // Newer reply displays immediately under thread-g.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "newer-displayed-reply",
          type: "thread.message.created",
          threadId: "thread-g",
          seq: 7,
          runId: "run-other-legacy",
          botId: "bot-b",
          payload: {
            id: "msg-newer-reply",
            role: "bot",
            blocks: [{ kind: "text", text: "Newer displayed reply" }],
          },
        },
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([["Scout", "Newer displayed reply", "thread-g"]]);

    // Snapshot resolves the older tool question as belonging to another member: must NOT replace seq 7.
    const snap = {
      threadId: "thread-g",
      cursor: 7,
      olderCursor: null,
      activeRuns: [{ id: "run-other-legacy", botId: "bot-b", status: "running", userId: "user-2" }],
      messages: [
        {
          id: "msg-older-tq",
          blocks: [
            {
              kind: "tool_question",
              question: { source: "Calendar", message: "Older prompt", fields: [] },
              status: "pending",
              expiresAt: later,
              publicKey: "key",
            },
          ],
        },
        { id: "msg-newer-reply", blocks: [{ kind: "text", text: "Newer displayed reply" }] },
      ],
    } as unknown as ThreadSnapshot;
    snapshotRef.current = snap;
    act(() => hook.reconcileSnapshot(snap));
    expect(shown()).toEqual([["Scout", "Newer displayed reply", "thread-g"]]);
  });

  it("discards queued alerts on flush when the tab is focused or permission is denied, even with default permission or pending owner", async () => {
    FakeNotification.permission = "default";
    visible = false;
    focused = false;
    await open({ botId: "bot-b" });

    // Queue a reply in the background while permission is default.
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "bg-reply",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 5,
          botId: "bot-b",
          payload: {
            id: "msg-bg-reply",
            role: "bot",
            blocks: [{ kind: "text", text: "Queued in background" }],
          },
        },
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    // User focuses the tab and dismisses the permission prompt (stays "default").
    visible = true;
    focused = true;
    act(() => hook.flushPendingBrowserNotifications());

    // Later in the background, user grants permission: the previously viewed reply must stay gone.
    visible = false;
    focused = false;
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);

    // Separately, queue a legacy pending-owner ask while permission is default, then deny permission.
    FakeNotification.permission = "default";
    snapshotRef.current = null;
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "denied-pending-owner",
          type: "thread.message.created",
          threadId: "thread-b",
          seq: 6,
          runId: "run-denied-legacy",
          botId: "bot-b",
          payload: {
            id: "msg-denied-ask",
            role: "bot",
            blocks: [{ kind: "ask", text: "Should be discarded on deny?", status: "pending" }],
          },
        },
        "thread-b",
        5,
        true,
        "Scout",
        true,
        undefined,
      ),
    );

    FakeNotification.permission = "denied";
    act(() => hook.flushPendingBrowserNotifications());

    // Later permission is granted and ownership resolves: the denied ask must not reappear.
    FakeNotification.permission = "granted";
    act(() =>
      hook.notifyBrowserForEvent(
        {
          id: "denied-legacy-wait",
          type: "run.waiting_input",
          threadId: "thread-b",
          seq: 7,
          runId: "run-denied-legacy",
          botId: "bot-b",
          payload: { userId: "user-1" },
        },
        "thread-b",
        5,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown()).toEqual([]);
  });

  it("closes the stream when the shell unmounts", async () => {
    await open({ botId: "bot-a" });
    act(() => root.unmount());
    expect(signals[0]!.aborted).toBe(true);
    root = createRoot(document.createElement("div"));
  });
});
