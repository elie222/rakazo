import { createHmac } from "node:crypto";
import type * as SlackAdapterModule from "@chat-adapter/slack";
import type { AdapterContext, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

type SlackRequest = { method: string; params: Record<string, string> };

const slack = vi.hoisted(() => ({
  requests: [] as SlackRequest[],
  reactionResult: { ok: true } as Record<string, unknown>,
}));

const slackResults: Record<string, () => Record<string, unknown>> = {
  "auth.test": () => ({ ok: true, user_id: "UBOT", bot_id: "BBOT" }),
  "users.info": () => ({ ok: true, user: { name: "test-user", real_name: "Test User" } }),
  "reactions.add": () => slack.reactionResult,
};

vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof SlackAdapterModule>();
  return {
    ...actual,
    createSlackAdapter: (config: Parameters<typeof actual.createSlackAdapter>[0]) =>
      actual.createSlackAdapter({
        ...config,
        webClientOptions: {
          adapter: async (request) => {
            const method = (request.url ?? "").replace("https://slack.com/api/", "");
            slack.requests.push({
              method,
              params: Object.fromEntries(new URLSearchParams(String(request.data ?? ""))),
            });
            return {
              data: slackResults[method]?.() ?? { ok: false, error: "unknown_method" },
              status: 200,
              statusText: "OK",
              headers: {},
              config: request,
              request: { path: `/api/${method}` },
            };
          },
        },
      }),
  };
});

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};
const signingSecret = "test-slack-signing-secret";

async function receiveChannelMention() {
  const surface = new ChatSdkMessagingSurface(
    messagingPlatformsFromEnv({ slackBotToken: "xoxb-fake", slackSigningSecret: signingSecret }),
  );
  const events: MessagingInboundMessage[] = [];
  surface.onInbound(async (event) => {
    if (event.type === "message") events.push(event);
  });
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "TTEST",
    event_id: "EvTEST",
    authorizations: [{ user_id: "UBOT", is_bot: true }],
    event: {
      type: "message",
      channel_type: "channel",
      channel: "CTEST",
      user: "USENDER",
      text: "<@UBOT> ship it?",
      ts: "1700000000.000001",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  const response = await surface.handleWebhook(
    "slack",
    new Request("https://rakazo.test/api/v1/messaging/webhook/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
      body,
    }),
  );
  expect(response?.status).toBe(200);
  expect(events).toHaveLength(1);
  return { surface, event: events[0]! };
}

function reactionRequests() {
  return slack.requests.filter((request) => request.method === "reactions.add");
}

describe("Slack receipt", () => {
  beforeEach(() => {
    slack.requests.length = 0;
    slack.reactionResult = { ok: true };
  });

  it("reacts with eyes on the mention", async () => {
    const { surface, event } = await receiveChannelMention();
    try {
      await surface.acknowledge(event.threadId, event.handle, context);

      expect(event.threadId).toBe("slack:CTEST:1700000000.000001");
      expect(reactionRequests().map((request) => request.params)).toEqual([
        { token: "xoxb-fake", channel: "CTEST", timestamp: "1700000000.000001", name: "eyes" },
      ]);
    } finally {
      await surface.shutdown();
    }
  });

  it("treats a reaction Slack already has as delivered", async () => {
    const { surface, event } = await receiveChannelMention();
    slack.reactionResult = { ok: false, error: "already_reacted" };
    try {
      await expect(
        surface.acknowledge(event.threadId, event.handle, context),
      ).resolves.toBeUndefined();
      expect(reactionRequests()).toHaveLength(1);
    } finally {
      await surface.shutdown();
    }
  });

  it("surfaces any other Slack error", async () => {
    const { surface, event } = await receiveChannelMention();
    slack.reactionResult = { ok: false, error: "missing_scope" };
    try {
      await expect(surface.acknowledge(event.threadId, event.handle, context)).rejects.toThrow(
        "An API error occurred: missing_scope",
      );
    } finally {
      await surface.shutdown();
    }
  });
});
