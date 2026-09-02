import { describe, expect, it } from "vitest";
import {
  coalesceRoutineEventTriggers,
  hasChatChannelTriggers,
  matchingEventTriggers,
  normalizeRepoEventPayload,
  normalizeRepoName,
  textMentionsBot,
  triggerMatchesEvent,
  UNSUPPORTED_CHAT_CHANNEL_TRIGGER_MESSAGE,
  webhookEnabledFromTriggers,
  withoutChatChannelTriggers,
} from "./routine-event-triggers.js";

describe("routine event triggers", () => {
  it("coalesces legacy webhookEnabled into a webhook trigger", () => {
    expect(coalesceRoutineEventTriggers([], true)).toEqual([
      { id: "legacy-webhook", kind: "webhook" },
    ]);
    expect(coalesceRoutineEventTriggers([], false)).toEqual([]);
    expect(coalesceRoutineEventTriggers([{ id: "w1", kind: "webhook" }], false)).toEqual([
      { id: "w1", kind: "webhook" },
    ]);
    expect(webhookEnabledFromTriggers([{ id: "w1", kind: "webhook" }])).toBe(true);
    expect(
      webhookEnabledFromTriggers([
        {
          id: "r1",
          kind: "repo",
          repo: "acme/app",
          events: ["push"],
        },
      ]),
    ).toBe(false);
  });

  it("matches webhook triggers only for webhook events", () => {
    const trigger = { id: "w1", kind: "webhook" as const };
    expect(triggerMatchesEvent(trigger, { source: "webhook", payload: { ok: true } })).toBe(true);
    expect(
      triggerMatchesEvent(trigger, {
        source: "repo",
        repo: "acme/app",
        event: "push",
        payload: {},
      }),
    ).toBe(false);
  });

  it("matches repo triggers by exact repo and event pack", () => {
    const trigger = {
      id: "r1",
      kind: "repo" as const,
      repo: "Acme/App",
      events: ["pr_opened" as const, "ci" as const],
    };
    expect(
      triggerMatchesEvent(trigger, {
        source: "repo",
        repo: "acme/app",
        event: "pr_opened",
        payload: {},
      }),
    ).toBe(true);
    expect(
      triggerMatchesEvent(trigger, {
        source: "repo",
        repo: "acme/app",
        event: "push",
        payload: {},
      }),
    ).toBe(false);
    expect(
      triggerMatchesEvent(trigger, {
        source: "repo",
        repo: "acme/other",
        event: "pr_opened",
        payload: {},
      }),
    ).toBe(false);
  });

  it("matches chat triggers for channel keyword and dm mention", () => {
    const keyword = {
      id: "c1",
      kind: "chat" as const,
      scope: "channel" as const,
      target: "#alerts",
      match: "keyword" as const,
      keyword: "pager",
    };
    expect(
      triggerMatchesEvent(keyword, {
        source: "chat",
        provider: "slack",
        scope: "channel",
        targets: ["alerts"],
        text: "pager duty ping",
        mentioned: false,
        reaction: false,
        payload: {},
      }),
    ).toBe(true);
    expect(
      triggerMatchesEvent(keyword, {
        source: "chat",
        provider: "slack",
        scope: "channel",
        targets: ["alerts"],
        text: "all clear",
        mentioned: false,
        reaction: false,
        payload: {},
      }),
    ).toBe(false);

    const mention = {
      id: "c2",
      kind: "chat" as const,
      scope: "dm" as const,
      target: "U123",
      match: "mention" as const,
    };
    expect(
      triggerMatchesEvent(mention, {
        source: "chat",
        provider: "slack",
        scope: "dm",
        targets: ["U123"],
        text: "hello",
        mentioned: true,
        reaction: false,
        payload: {},
      }),
    ).toBe(true);
  });

  it("normalizes GitHub-shaped and neutral repo payloads", () => {
    expect(normalizeRepoName("https://github.com/Acme/App.git")).toBe("acme/app");

    const github = normalizeRepoEventPayload(
      {
        action: "opened",
        pull_request: { merged: false },
        repository: { full_name: "acme/app" },
      },
      { eventName: "pull_request" },
    );
    expect(github).toMatchObject({ source: "repo", repo: "acme/app", event: "pr_opened" });

    const merged = normalizeRepoEventPayload(
      {
        action: "closed",
        pull_request: { merged: true },
        repository: { full_name: "acme/app" },
      },
      { eventName: "pull_request" },
    );
    expect(merged?.event).toBe("pr_merged");

    const neutral = normalizeRepoEventPayload({
      repo: "acme/app",
      event: "push",
      ref: "refs/heads/main",
    });
    expect(neutral).toMatchObject({ source: "repo", repo: "acme/app", event: "push" });

    expect(normalizeRepoEventPayload({ text: "hello" })).toBeNull();
  });

  it("filters matching triggers for an event", () => {
    const triggers = [
      { id: "w1", kind: "webhook" as const },
      {
        id: "r1",
        kind: "repo" as const,
        repo: "acme/app",
        events: ["push" as const],
      },
    ];
    expect(
      matchingEventTriggers(triggers, { source: "webhook", payload: {} }).map((t) => t.id),
    ).toEqual(["w1"]);
    expect(
      matchingEventTriggers(triggers, {
        source: "repo",
        repo: "acme/app",
        event: "push",
        payload: {},
      }).map((t) => t.id),
    ).toEqual(["r1"]);
  });

  it("appends webhook when webhookEnabled is true alongside other triggers", () => {
    const triggers = coalesceRoutineEventTriggers(
      [
        {
          id: "r1",
          kind: "repo",
          repo: "acme/app",
          events: ["push"],
        },
      ],
      true,
    );
    expect(triggers.map((trigger) => trigger.kind).sort()).toEqual(["repo", "webhook"]);
  });

  it("strips @ and # from chat targets", () => {
    const trigger = {
      id: "c3",
      kind: "chat" as const,
      scope: "dm" as const,
      target: "@alice",
      match: "message" as const,
    };
    expect(
      triggerMatchesEvent(trigger, {
        source: "chat",
        provider: "slack",
        scope: "dm",
        targets: ["alice"],
        text: "hi",
        mentioned: false,
        reaction: false,
        payload: {},
      }),
    ).toBe(true);
  });

  it("matches reactions without requiring text", () => {
    const trigger = {
      id: "c4",
      kind: "chat" as const,
      scope: "dm" as const,
      target: "U1",
      match: "reaction" as const,
    };
    expect(
      triggerMatchesEvent(trigger, {
        source: "chat",
        provider: "slack",
        scope: "dm",
        targets: ["U1"],
        text: "",
        mentioned: false,
        reaction: true,
        payload: {},
      }),
    ).toBe(true);
    expect(
      triggerMatchesEvent(trigger, {
        source: "chat",
        provider: "slack",
        scope: "dm",
        targets: ["U1"],
        text: "hello",
        mentioned: false,
        reaction: false,
        payload: {},
      }),
    ).toBe(false);
  });

  it("detects this-bot mentions, not arbitrary @words", () => {
    expect(textMentionsBot("hey @Scout please look", ["Scout", "B123"])).toBe(true);
    expect(textMentionsBot("ping <@B123>", ["Scout", "B123"])).toBe(true);
    expect(textMentionsBot("ping <@B123>", ["Scout", "<@B123>"])).toBe(true);
    expect(textMentionsBot("hey @someone else", ["Scout", "B123"])).toBe(false);
    expect(textMentionsBot("no mention here", ["Scout"])).toBe(false);
    expect(textMentionsBot("hey @ScoutTeam please look", ["Scout"])).toBe(false);
    expect(textMentionsBot("notes for @Chiefly", ["Chief"])).toBe(false);
  });

  it("withoutChatChannelTriggers drops channel-scoped chat triggers", () => {
    const triggers = [
      {
        id: "c1",
        kind: "chat" as const,
        scope: "channel" as const,
        target: "general",
        match: "message" as const,
      },
      {
        id: "c2",
        kind: "chat" as const,
        scope: "dm" as const,
        target: "U1",
        match: "mention" as const,
      },
      { id: "w1", kind: "webhook" as const },
    ];
    expect(hasChatChannelTriggers(triggers)).toBe(true);
    expect(withoutChatChannelTriggers(triggers)).toEqual([
      { id: "c2", kind: "chat", scope: "dm", target: "U1", match: "mention" },
      { id: "w1", kind: "webhook" },
    ]);
    expect(UNSUPPORTED_CHAT_CHANNEL_TRIGGER_MESSAGE.toLowerCase()).toContain("dm");
  });

  it("coalesceRoutineEventTriggers drops channel chat triggers used by dispatch", () => {
    expect(
      coalesceRoutineEventTriggers(
        [
          {
            id: "c1",
            kind: "chat",
            scope: "channel",
            target: "general",
            match: "message",
          },
          {
            id: "c2",
            kind: "chat",
            scope: "dm",
            target: "U1",
            match: "mention",
          },
        ],
        false,
      ),
    ).toEqual([
      {
        id: "c2",
        kind: "chat",
        scope: "dm",
        target: "U1",
        match: "mention",
      },
    ]);
  });
});
