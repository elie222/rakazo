vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import { mergeThreadSnapshot, reduceThreadSnapshot } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage, MobileSnapshot } from "./mobile-types.js";
import {
  blockText,
  mobileThreadRefreshResult,
  prependMobileMessagePage,
  shouldApplyMobileThreadRefresh,
} from "./mobile-types.js";
import { threadRefreshDelayMs } from "./refresh";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { mobileMessage, snapshot } from "./api-test-helpers";

describe("mobile thread refresh targeting", () => {
  it("drops a deferred group A refresh after navigation to group B", async () => {
    let activeGroupId: string | undefined = "group-a";
    let currentEpoch = 1;
    let resolveRequest!: (snapshot: MobileSnapshot) => void;
    const request = new Promise<MobileSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    let applied: MobileSnapshot | null = null;
    const refresh = request.then((snapshot) => {
      if (
        shouldApplyMobileThreadRefresh({
          requestEpoch: 1,
          currentEpoch,
          targetBotId: undefined,
          targetGroupId: "group-a",
          activeBotId: undefined,
          activeGroupId,
        })
      ) {
        applied = snapshot;
      }
    });

    activeGroupId = "group-b";
    currentEpoch += 1;
    resolveRequest({
      groupId: "group-a",
      threadId: "thread-a",
      messages: [],
      olderCursor: null,
      run: null,
    });
    await refresh;

    expect(applied).toBeNull();
  });
});

describe("discarded mobile thread refresh cursor", () => {
  const onScreen = {
    ...snapshot([mobileMessage("shown", [{ kind: "text", text: "shown" }], 2)]),
    cursor: 2,
  };
  const fetched = {
    ...snapshot([
      mobileMessage("shown", [{ kind: "text", text: "shown" }], 2),
      mobileMessage("missed", [{ kind: "text", text: "from the discarded snapshot" }], 4),
      mobileMessage("also-missed", [{ kind: "text", text: "also only in that snapshot" }], 5),
    ]),
    cursor: 5,
  };
  const gate = {
    fetched,
    onScreen,
    requestEpoch: 1,
    currentEpoch: 1,
    requestGeneration: 1,
    currentGeneration: 1,
    targetBotId: "bot-1",
    targetGroupId: undefined,
    activeBotId: "bot-1",
    activeGroupId: undefined,
  };

  // The server replays events with seq greater than the subscription cursor.
  function shownAfter(cursor: number) {
    const events = [
      {
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "missed",
          role: "bot",
          blocks: [{ kind: "text", text: "from the discarded snapshot" }],
        },
      },
      {
        type: "thread.message.created",
        seq: 5,
        payload: {
          messageId: "also-missed",
          role: "bot",
          blocks: [{ kind: "text", text: "also only in that snapshot" }],
        },
      },
    ];
    return events.reduce<MobileSnapshot>(
      (view, event) => (event.seq > cursor ? (reduceThreadSnapshot(view, event) ?? view) : view),
      onScreen,
    );
  }

  it("shows events only a discarded refresh had seen when a newer refresh fails", () => {
    for (const discard of [{ currentGeneration: 2 }, { currentEpoch: 2 }]) {
      const result = mobileThreadRefreshResult({ ...gate, ...discard });
      const shown = shownAfter(result.snapshot?.cursor ?? -1);
      expect(result.commit).toBe(false);
      expect(shown.messages.map((message) => message.id)).toEqual([
        "shown",
        "missed",
        "also-missed",
      ]);
    }
  });

  it("keeps a live message applied while a refresh snapshot was in flight", () => {
    const live = reduceThreadSnapshot(fetched, {
      type: "thread.message.created",
      seq: 6,
      payload: {
        messageId: "new-live-message",
        role: "user",
        blocks: [{ kind: "text", text: "New message" }],
      },
    })!;
    const result = mobileThreadRefreshResult({ ...gate, onScreen: live });
    expect(result.commit).toBe(false);
    expect(result.snapshot).toBe(live);
    expect(result.snapshot?.messages.at(-1)?.id).toBe("new-live-message");
    expect(result.snapshot?.cursor).toBe(6);
    expect(mobileThreadRefreshResult({ ...gate, onScreen: fetched }).commit).toBe(true);
  });

  it("starts the subscription at a snapshot the refresh committed", () => {
    const result = mobileThreadRefreshResult(gate);
    expect(result.commit).toBe(true);
    expect(result.snapshot?.cursor).toBe(fetched.cursor);
  });
});

describe("mobile thread event reduction", () => {
  it("prepends ordered history pages without duplicating the boundary message", () => {
    const initial = snapshot([mobileMessage("m-2", [], 2), mobileMessage("m-3", [], 3)], 2);

    const next = prependMobileMessagePage(initial, {
      threadId: "thread-1",
      messages: [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("m-2", [], 2),
      ],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("retains loaded history across refresh while dropping stale progress", () => {
    const initial = snapshot(
      [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }], 8),
      ],
      null,
    );
    const refreshed = snapshot([mobileMessage("m-1", [], 1), mobileMessage("m-2", [], 2)], 1);

    const next = mergeThreadSnapshot(initial, refreshed, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("holds live tool steps until mobile narration reaches a sentence boundary", () => {
    const narration = reduceThreadSnapshot(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { text: "Let me check " },
    });
    const pending = reduceThreadSnapshot(narration, {
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });
    const completed = reduceThreadSnapshot(pending, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "now." },
    });

    expect(pending?.messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check ",
        pendingToolNames: ["SLACK_FIND_CHANNELS"],
      },
    ]);
    expect(completed?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
    expect(blockText(completed?.messages[0] as MobileMessage)).toBe(
      "Let me check now.\nSlack find channels",
    );
  });

  it("shows the owner's email by its subject and words", () => {
    expect(
      blockText(
        mobileMessage("email-1", [
          {
            kind: "email",
            emailId: "email-1",
            from: "Owner <owner@example.test>",
            to: ["bot@bots.example.test"],
            subject: "Weekly plan",
            text: "Send me the plan.\n",
          },
        ]),
      ),
    ).toBe("✉︎ Weekly plan\nSend me the plan.");
  });

  it("formats channel messages with their platform attribution", () => {
    expect(
      blockText(
        mobileMessage("channel-1", [
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("Alex (SMS): Hello from the group");
    expect(
      blockText(
        mobileMessage("channel-2", [
          {
            kind: "channel_message",
            provider: "slack",
            channelId: "ch-2",
            fromAddress: "U123456",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("Alex (Slack): Hello from the group");
  });

  it("lets a newer refresh replace waiting_takeover with queued", () => {
    const waiting: MobileSnapshot = {
      ...snapshot(),
      cursor: 10,
      run: { id: "run-1", status: "waiting_takeover" },
      activeRuns: [{ id: "run-1", status: "waiting_takeover" }],
    };
    const refreshed: MobileSnapshot = {
      ...snapshot(),
      cursor: 12,
      run: { id: "run-1", status: "queued" },
      activeRuns: [{ id: "run-1", status: "queued" }],
    };

    const next = mergeThreadSnapshot(waiting, refreshed);

    expect(next.cursor).toBe(12);
    expect(next.run?.status).toBe("queued");
    expect(next.activeRuns?.[0]?.status).toBe("queued");
  });

  it("starts an idle run from live events and selects the active safety cadence", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: null, activeRuns: [] };
    expect(threadRefreshDelayMs(initial.run?.status, { liveSubscribed: true })).toBe(60_000);
    const started = reduceThreadSnapshot(initial, {
      type: "run.started",
      runId: "run-remote",
      botId: "bot-1",
      seq: 12,
      payload: { trigger: "routine" },
    });
    expect(started?.cursor).toBe(12);
    expect(started?.run).toMatchObject({
      id: "run-remote",
      botId: "bot-1",
      status: "running",
      trigger: "routine",
      error: null,
    });
    expect(started?.activeRuns).toEqual([started?.run]);
    expect(threadRefreshDelayMs(started?.run?.status, { liveSubscribed: true })).toBe(30_000);
    const finished = reduceThreadSnapshot(started, {
      type: "run.completed",
      runId: "run-remote",
      seq: 13,
    });
    expect(finished?.run).toBeNull();
    expect(finished?.activeRuns).toEqual([]);
  });
});
