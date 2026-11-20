import { replaceBareMentions } from "@chat-adapter/shared";
import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { convertEmojiPlaceholders } from "chat";
import {
  asRecord,
  defineMessagingPlatform,
} from "../../../messaging/messaging-platform-descriptor.js";
import { LazyDiscordAdapter } from "./lazy-adapter.js";

/**
 * Discord direct messages and guild channels. The adapter loads on first use;
 * regular guild messages arrive over the Gateway in the one process that owns
 * the inbound sink, while forwarded interactions use the generic webhook route.
 */
export const discordMessaging = defineMessagingPlatform({
  env: {
    discordBotToken: { name: "DISCORD_BOT_TOKEN", required: true },
    discordPublicKey: { name: "DISCORD_PUBLIC_KEY", required: true },
    discordApplicationId: { name: "DISCORD_APPLICATION_ID", required: true },
    discordMentionRoleIds: { name: "DISCORD_MENTION_ROLE_IDS" },
  },
  mount(env, options) {
    const mentionRoleIds = env.discordMentionRoleIds
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const adapter = new LazyDiscordAdapter({
      botToken: env.discordBotToken,
      publicKey: env.discordPublicKey,
      applicationId: env.discordApplicationId,
      ...(mentionRoleIds?.length ? { mentionRoleIds } : {}),
      pollInboundMessages: options.pollInboundMessages ?? false,
    });
    return {
      provider: "discord",
      // Guild channels are team-chat rooms, like Slack's: one conversation per
      // channel, a reply thread when the person files one, and ambient messages
      // the listen policy decides on.
      capabilities: { direct: true, groups: true, receipt: "reaction" },
      // A guild channel is a team room; a direct message is nobody's room.
      teamRooms: { requiresWorkspace: true },
      adapter,
      enrichTeamRoom: (raw, base) => {
        const enrichment = enrichDiscordTeamRoom(raw, base);
        if (base.isDirect) return enrichment;
        // Discord's gateway payload carries no channel name, so the name is the one the
        // adapter read before delivering. An unreadable channel stays unnamed: the settings
        // list falls back to its own wording, never to the raw id.
        const channelName = adapter.channelNameForThread(base.threadId);
        return channelName ? { ...enrichment, channelName } : enrichment;
      },
      isPermanentSendError: discordIsPermanentSendError,
      // Forwarded events carry no vendor idempotency id outside their Discord
      // message id, which the Chat SDK already deduplicates, so there is no
      // delivery marker to clear when the inbound sink fails.
    };
  },
});

/** Discord's message content limit, in UTF-16 units. */
export const DISCORD_MARKDOWN_LIMIT = 2_000;

/** A Discord user or role id is at most this long; the adapter writes `@name` as `<@name>`. */
const DISCORD_USER_ID_LENGTH = 20;

/**
 * The text the adapter sends for a Markdown part: emoji placeholders resolved and
 * each bare `@name` mention written as long as its `<@id>` form can be, so a part
 * never grows past the limit. Without it the splitter would measure the short
 * `@name` and the adapter would then send a longer mention.
 */
export function discordPayloads(markdown: string): string[] {
  return [
    replaceBareMentions(
      convertEmojiPlaceholders(markdown, "discord"),
      (_mention, name) => `<@${name.padEnd(DISCORD_USER_ID_LENGTH, "0")}>`,
    ),
  ];
}

/**
 * Discord API codes a retry cannot fix: the channel, role or member is gone, the
 * bot cannot see it, or its direct messages are closed.
 */
const DISCORD_PERMANENT_CODES = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10007, // Unknown Member
  10008, // Unknown Message
  10011, // Unknown Role
  10013, // Unknown User
  10014, // Unknown Emoji
  10015, // Unknown Webhook
  40003, // Invalid intent
  50001, // Missing Access
  50007, // Cannot send messages to this user
  50013, // Missing Permissions
]);

/** HTTP answers a retry cannot fix: the token is dead or the target is gone. */
const DISCORD_PERMANENT_STATUS = new Set([401, 403, 404]);

/** Errors the Chat SDK raises before it ever calls Discord. */
const DISCORD_PERMANENT_ERROR_CODES = new Set(["PERMISSION_DENIED", "AUTH_FAILED", "NOT_FOUND"]);

const DISCORD_PERMANENT_TEXT = /unknown channel|unknown role|missing access|missing permissions/i;

/**
 * Discord reports these on the API error the Chat SDK wraps: its `NetworkError`
 * keeps `code` as "NETWORK_ERROR" and carries the platform's own numeric `code`
 * and HTTP `status` on `originalError`.
 */
export function discordIsPermanentSendError(error: unknown): boolean {
  const top = asRecord(error);
  const platform = asRecord(top?.originalError) ?? asRecord(top?.cause);
  const code = platform?.code ?? top?.code;
  if (typeof code === "number" && DISCORD_PERMANENT_CODES.has(code)) return true;
  if (typeof code === "string" && DISCORD_PERMANENT_ERROR_CODES.has(code)) return true;
  const status = platform?.status ?? top?.status;
  if (typeof status === "number" && DISCORD_PERMANENT_STATUS.has(status)) return true;
  const text = [error, top?.originalError]
    .map((value) => (value instanceof Error ? value.message : String(value ?? "")))
    .join(" ");
  return DISCORD_PERMANENT_TEXT.test(text);
}

/**
 * The guild, parent channel and thread a Rakazo thread id names; null for a
 * direct message, whose guild segment is "@me".
 */
function discordPlacement(
  threadId: string,
): { workspaceId: string; channelId: string; threadId: string | null } | null {
  const parts = threadId.split(":");
  if (parts[0] !== "discord" || parts.length < 3) return null;
  const workspaceId = parts[1];
  const channelId = parts[2];
  if (!workspaceId || !channelId || workspaceId === "@me") return null;
  return { workspaceId, channelId, threadId: parts[3] || null };
}

/**
 * Pull the team-room fields the Chat SDK does not expose on a gateway message.
 * The adapter's thread id is authoritative: it already names the guild, the
 * parent channel and, inside a thread, the thread itself. The raw payload only
 * adds what the SDK drops — that the author is another bot.
 *
 * The conversation is the channel, not the thread, so a mention and the replies
 * it gathers in Discord's auto-created thread stay one conversation, and the
 * thread travels per message as that message's reply destination.
 */
export function enrichDiscordTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  if (!root) return {};
  // Tolerate the forwarded { type, data, timestamp } envelope as well as the message itself.
  const data = asRecord(root.data) ?? root;
  const botFlag = asRecord(data.author)?.bot === true ? { senderIsBot: true } : {};
  if (base.isDirect) return botFlag;
  const placement = discordPlacement(base.threadId);
  if (!placement) return botFlag;
  return {
    workspaceId: placement.workspaceId,
    conversationKey: `discord:${placement.workspaceId}:${placement.channelId}`,
    replyThreadId: placement.threadId,
    // Another bot's message waits for the room's Ambient setting instead of starting a run,
    // like any other message the bot was not asked for, so two agents cannot ping-pong.
    kind: botFlag.senderIsBot || !base.mentionsBot ? "ambient" : "mention",
    ...botFlag,
  };
}
