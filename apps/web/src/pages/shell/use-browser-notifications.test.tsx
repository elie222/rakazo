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

  it("announces the viewer's own ask, an unknown-run ask, and the viewer's own pending tool question in a snoozed chat", async () => {
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
        {
          ...reply("bg-ask", [{ kind: "ask", text: "Approve deploy?", status: "pending" }]),
          runId: "run-background",
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

  it("closes the stream when the shell unmounts", async () => {
    await open({ botId: "bot-a" });
    act(() => root.unmount());
    expect(signals[0]!.aborted).toBe(true);
    root = createRoot(document.createElement("div"));
  });
});
