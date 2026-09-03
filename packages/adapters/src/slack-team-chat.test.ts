import { describe, expect, it, vi } from "vitest";
import {
  parseSlackSocketEnvelope,
  SlackTeamChatProvider,
  slackConversationMemberIds,
  slackConversationMetadata,
  slackTeamChatConfigFromEnv,
  splitSlackMessage,
} from "./slack-team-chat.js";

describe("Slack team chat adapter", () => {
  it("normalizes a channel mention into an isolated Slack thread", () => {
    const parsed = parseSlackSocketEnvelope(
      {
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event_id: "Ev-1",
          team_id: "T-1",
          event: {
            type: "app_mention",
            user: "U-1",
            channel: "C-1",
            text: "<@U-ARTHUR> please summarize this",
            ts: "100.001",
          },
        },
      },
      "U-ARTHUR",
    );

    expect(parsed).toEqual({
      envelopeId: "env-1",
      message: {
        eventId: "Ev-1",
        workspaceId: "T-1",
        kind: "mention",
        conversationKey: "channel:C-1",
        conversationId: "C-1",
        replyThreadId: "100.001",
        senderId: "U-1",
        senderName: "U-1",
        content: "please summarize this",
      },
    });
  });

  it("keeps direct messages in one private conversation", () => {
    const parsed = parseSlackSocketEnvelope(
      {
        envelope_id: "env-2",
        type: "events_api",
        payload: {
          event_id: "Ev-2",
          team_id: "T-1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U-2",
            channel: "D-1",
            text: "hello",
            ts: "101.001",
          },
        },
      },
      "U-ARTHUR",
    );

    expect(parsed.message).toMatchObject({
      kind: "direct",
      conversationKey: "dm:D-1",
      conversationId: "D-1",
      replyThreadId: null,
      content: "hello",
    });
  });

  it("normalizes ordinary channel messages for ambient evaluation", () => {
    const parsed = parseSlackSocketEnvelope(
      {
        envelope_id: "env-ambient",
        type: "events_api",
        payload: {
          event_id: "Ev-ambient",
          team_id: "T-1",
          event: {
            type: "message",
            channel_type: "channel",
            user: "U-2",
            channel: "C-1",
            text: "The launch date moved to Friday",
            ts: "103.001",
          },
        },
      },
      "U-ARTHUR",
    );

    expect(parsed.message).toMatchObject({
      kind: "ambient",
      conversationType: "channel",
      conversationKey: "channel:C-1",
      conversationId: "C-1",
      replyThreadId: "103.001",
      content: "The launch date moved to Friday",
    });
  });

  it("keeps third-party bot posts for room policy evaluation", () => {
    const parsed = parseSlackSocketEnvelope(
      {
        envelope_id: "env-bot",
        type: "events_api",
        payload: {
          event_id: "Ev-bot",
          team_id: "T-1",
          event: {
            type: "message",
            subtype: "bot_message",
            bot_id: "B-GITHUB",
            bot_profile: { name: "GitHub" },
            channel_type: "channel",
            channel: "C-1",
            text: "Pull request #42 is ready for review",
            ts: "103.002",
          },
        },
      },
      "U-ARTHUR",
    );

    expect(parsed.message).toMatchObject({
      kind: "ambient",
      senderId: "B-GITHUB",
      senderName: "GitHub",
      senderIsBot: true,
      content: "Pull request #42 is ready for review",
    });
  });

  it("does not mirror a mention through the ambient message event", () => {
    const parsed = parseSlackSocketEnvelope(
      {
        envelope_id: "env-duplicate",
        type: "events_api",
        payload: {
          event_id: "Ev-duplicate",
          team_id: "T-1",
          event: {
            type: "message",
            channel_type: "channel",
            user: "U-2",
            channel: "C-1",
            text: "<@U-ARTHUR> can you help?",
            ts: "104.001",
          },
        },
      },
      "U-ARTHUR",
    );

    expect(parsed.message).toBeUndefined();
  });

  it("ignores Arthur's own messages, edited messages, and empty mentions", () => {
    const base = {
      envelope_id: "env-3",
      type: "events_api",
      payload: {
        event_id: "Ev-3",
        team_id: "T-1",
        event: {
          type: "app_mention",
          user: "U-1",
          channel: "C-1",
          text: "<@U-ARTHUR>",
          ts: "102.001",
        },
      },
    };
    expect(parseSlackSocketEnvelope(base, "U-ARTHUR").message).toBeUndefined();
    expect(
      parseSlackSocketEnvelope(
        {
          ...base,
          payload: {
            ...base.payload,
            event: {
              ...base.payload.event,
              user: "U-ARTHUR",
              bot_id: "B-ARTHUR",
              subtype: "bot_message",
            },
          },
        },
        "U-ARTHUR",
      ).message,
    ).toBeUndefined();
    expect(
      parseSlackSocketEnvelope(
        {
          ...base,
          payload: {
            ...base.payload,
            event: {
              ...base.payload.event,
              type: "message",
              channel_type: "channel",
              user: undefined,
              bot_id: "B-ARTHUR",
              subtype: "bot_message",
              text: "Arthur's reply",
            },
          },
        },
        "U-ARTHUR",
        "B-ARTHUR",
      ).message,
    ).toBeUndefined();
    expect(
      parseSlackSocketEnvelope(
        {
          ...base,
          payload: {
            ...base.payload,
            event: { ...base.payload.event, subtype: "message_changed" },
          },
        },
        "U-ARTHUR",
      ).message,
    ).toBeUndefined();
  });

  it("loads both tokens without accepting a half-configured adapter", () => {
    expect(slackTeamChatConfigFromEnv({})).toBeNull();
    expect(() => slackTeamChatConfigFromEnv({ SLACK_APP_TOKEN: "xapp-only" })).toThrow(
      "SLACK_BOT_TOKEN",
    );
    expect(
      slackTeamChatConfigFromEnv({
        SLACK_APP_TOKEN: " xapp-test ",
        SLACK_BOT_TOKEN: " xoxb-test ",
      }),
    ).toEqual({ appToken: "xapp-test", botToken: "xoxb-test" });
  });

  it("extracts every participant from a multi-person direct message", () => {
    expect(
      slackConversationMemberIds({
        is_mpim: true,
        members: ["U-MORGAN", "U-CHIEF", "U-PAT"],
      }),
    ).toEqual(["U-MORGAN", "U-CHIEF", "U-PAT"]);
    expect(slackConversationMemberIds({ is_mpim: false, members: ["U-MORGAN", "U-PAT"] })).toEqual(
      [],
    );
  });

  it("uses member display names instead of Slack's generated MPIM identifier", async () => {
    const names = new Map([
      ["U-MORGAN", "Morgan"],
      ["U-CHIEF", "Chief"],
      ["U-PAT", "Pat"],
    ]);
    await expect(
      slackConversationMetadata(
        {
          is_mpim: true,
          name: "mpdm-morgan--chief--pat-1",
          members: [...names.keys()],
        },
        async (memberId) => names.get(memberId) ?? "Slack member",
      ),
    ).resolves.toEqual({
      displayName: "Morgan, Chief, Pat",
      participantNames: ["Morgan", "Chief", "Pat"],
    });
  });

  it("splits long replies and posts every chunk in the same thread", async () => {
    expect(splitSlackMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      const text = body.get("text") ?? "";
      return new Response(JSON.stringify({ ok: true, ts: `reply-${text}` }), {
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new SlackTeamChatProvider(
      { appToken: "xapp-test", botToken: "xoxb-test" },
      { fetch: fetchMock as typeof fetch, maxMessageChars: 4 },
    );

    await expect(
      provider.send({
        conversationId: "C-1",
        replyThreadId: "100.1",
        content: "abcdefghij",
      }),
    ).resolves.toEqual({ handle: "reply-ij" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      Object.fromEntries(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body))),
    ).toEqual({
      channel: "C-1",
      text: "abcd",
      thread_ts: "100.1",
    });
  });
});
