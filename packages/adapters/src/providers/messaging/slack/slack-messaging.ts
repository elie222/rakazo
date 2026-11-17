import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { Adapter } from "chat";
import { boundInboundMarkdown } from "../../../messaging/chat-sdk-surface.js";
import { lazyChatAdapter } from "../../../messaging/lazy-chat-adapter.js";
import {
  asRecord,
  defineMessagingPlatform,
  MESSAGING_SEND_TIMEOUT_MS,
  stringField,
} from "../../../messaging/messaging-platform-descriptor.js";

export const slackMessaging = defineMessagingPlatform({
  env: {
    slackBotToken: { name: "SLACK_BOT_TOKEN", required: true },
    slackSigningSecret: { name: "SLACK_SIGNING_SECRET", required: true },
  },
  mount(env) {
    const config = {
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      // WebClient defaults to ten retries over ~30 minutes with no timeout,
      // sleeping through rate limits; that duplicates posts and stalls the
      // outbox. Fail fast and let the outbox back off (honouring retryAfter).
      webClientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: MESSAGING_SEND_TIMEOUT_MS,
      },
    };
    const adapter = lazyChatAdapter("slack", async () => {
      const { createSlackAdapter } = await import("@chat-adapter/slack");
      const slack = createSlackAdapter(config);
      boundInboundMarkdown(slack);
      // Slack's reactions.add fails with already_reacted when a replayed inbound reacts twice.
      const addReaction = slack.addReaction.bind(slack);
      Object.assign(slack, {
        addReaction: (threadId, messageId, emoji) =>
          addReaction(threadId, messageId, emoji).catch((error: unknown) => {
            if (slackPlatformError(error) !== "already_reacted") throw error;
          }),
      } satisfies Pick<Adapter, "addReaction">);
      return slack;
    });
    return {
      provider: "slack",
      capabilities: { direct: true, groups: true, receipt: "reaction" },
      adapter,
      enrichTeamRoom: enrichSlackTeamRoom,
      redeliveryKeys: slackRedeliveryKeys,
      isPermanentSendError: (error) => SLACK_PERMANENT_ERRORS.has(slackPlatformError(error) ?? ""),
    };
  },
});

/** Slack errors a retry cannot fix: the bot cannot reach the channel or its token is dead. */
const SLACK_PERMANENT_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
]);

/** Slack's marker for a dispatched event; it turns Slack's retries into no-ops. */
function slackRedeliveryKeys(payload: unknown): string[] {
  const eventId = stringField(asRecord(payload) ?? {}, "event_id");
  return eventId ? [`slack:event-delivered:${eventId}`] : [];
}

/** Pull Slack team-room fields the Chat SDK does not expose on Message. */
export function enrichSlackTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  if (!root) return {};
  const event = asRecord(root.event) ?? root;
  const teamId =
    stringField(root, "team_id") ?? stringField(event, "team") ?? stringField(event, "team_id");
  const eventType = stringField(event, "type");
  const botProfile = asRecord(event.bot_profile) ?? {};
  const botId = stringField(event, "bot_id") ?? stringField(botProfile, "id");
  const threadTs = stringField(event, "thread_ts");
  const channel = stringField(event, "channel");
  const enrichment: Partial<MessagingInboundMessage> = {};
  if (teamId) enrichment.workspaceId = teamId;
  if (channel) enrichment.conversationKey = channel;
  if (botId) enrichment.senderIsBot = true;
  else if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    enrichment.senderIsBot = true;
  }
  if (threadTs) enrichment.replyThreadId = threadTs;
  else enrichment.replyThreadId = null;
  if (!base.isDirect) {
    // Slack sends both app_mention and message.* for one channel mention and
    // the SDK keeps whichever arrives first, so the plain event relies on the
    // SDK's own mention check. A mention of someone else stays ambient so
    // listen policy still applies.
    enrichment.kind = eventType === "app_mention" || base.mentionsBot ? "mention" : "ambient";
  }
  return enrichment;
}

function slackPlatformError(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record?.code !== "slack_webapi_platform_error") return undefined;
  return stringField(asRecord(record.data) ?? {}, "error");
}
