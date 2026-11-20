import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  MessagingInboundMessage,
  MessagingSurface,
  TeamChatInboundMessage,
  TeamChatMessageKind,
  TeamChatSendRequest,
  TeamChatSendResult,
} from "@rakazo/adapter-kit";

/** Map a Chat SDK inbound message into a team-chat event, or null if empty. */
export function toTeamChatInbound(event: MessagingInboundMessage): TeamChatInboundMessage | null {
  const mediaUrl = event.attachments?.length ? "" : event.mediaUrl?.trim();
  const mediaLine = mediaUrl ? `\n${mediaUrl}` : "";
  const content = `${event.content}${mediaLine}`.trim();
  if (!content && !event.attachments?.length) return null;

  const kind: TeamChatMessageKind = event.isDirect
    ? "direct"
    : (event.kind ?? (looksLikeMention(event.content, event.channelName) ? "mention" : "ambient"));

  return {
    eventId: event.handle,
    workspaceId: event.workspaceId ?? event.provider,
    kind,
    conversationKey: event.conversationKey ?? event.threadId,
    conversationId: event.threadId,
    conversationName: event.channelName ?? undefined,
    participantNames: event.participantNames?.length
      ? event.participantNames
      : event.participants.length
        ? event.participants
        : undefined,
    replyThreadId: event.replyThreadId ?? null,
    senderId: event.from,
    senderName: event.fromLabel?.trim() || event.from,
    senderIsBot: event.senderIsBot,
    content,
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  };
}

function looksLikeMention(content: string, channelName: string | null): boolean {
  if (channelName == null && !content.includes("@")) return false;
  return /(^|\s)@[\w.-]+/.test(content);
}

/**
 * Chat SDK room thread ids name the platform's own nesting. Team-chat stores the
 * room conversation id separately from the reply thread, so outbound sends must
 * recombine them when a reply thread is present:
 *
 * - `slack:CHANNEL:threadTs` — the thread occupies the third segment.
 * - `discord:GUILD:CHANNEL:threadId` — the thread occupies the fourth.
 */
export function resolveMessagingThreadId(
  conversationId: string,
  replyThreadId: string | null,
): string {
  if (!replyThreadId) return conversationId;
  if (conversationId.endsWith(`:${replyThreadId}`)) return conversationId;
  const parts = conversationId.split(":");
  // provider:guild:channel[:thread] → provider:guild:channel:replyThreadId
  if (parts[0] === "discord" && parts[1] && parts[2]) {
    return `${parts[0]}:${parts[1]}:${parts[2]}:${replyThreadId}`;
  }
  // provider:channel[:existingTs] → provider:channel:replyThreadId
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0]}:${parts[1]}:${replyThreadId}`;
  }
  return `${conversationId}:${replyThreadId}`;
}

/**
 * The thread id of the conversation itself, with no reply thread. A team-chat conversation is a
 * channel, but providers store the channel differently: Slack keys it by the bare channel
 * (`C1`, or `<installationId>:C1` once the app is installed), Discord by an id that is already a
 * thread id (`discord:G1:C1`). Rebuilding it from the key keeps an answer in its channel even
 * after a newer message moved the conversation's own `conversationId` to another thread.
 *
 * The rebuild only stands when it agrees with the stored thread id, so a provider whose key is
 * not derived from its thread id keeps the previous behaviour.
 */
export function conversationChannelThreadId(conversation: {
  provider?: string | undefined;
  externalKey?: string | undefined;
  conversationId: string;
}): string {
  const { provider, externalKey, conversationId } = conversation;
  if (!provider || !externalKey) return conversationId;
  const head = conversationId.split(":", 1)[0] ?? "";
  const [scope, installation] = head.split("~", 2);
  if (scope !== provider) return conversationId;
  let channel: string;
  if (installation) {
    if (!externalKey.startsWith(`${installation}:`)) return conversationId;
    channel = `${head}:${externalKey.slice(installation.length + 1)}`;
  } else if (externalKey.startsWith(`${provider}:`)) {
    channel = externalKey;
  } else {
    channel = `${provider}:${externalKey}`;
  }
  return conversationId === channel || conversationId.startsWith(`${channel}:`)
    ? channel
    : conversationId;
}

/**
 * Where a team-chat answer belongs: the conversation's channel, with the reply thread its own
 * message arrived in re-attached (Slack nests it in the third segment, Discord in the fourth).
 */
export function teamChatReplyThreadId(
  conversation: {
    provider?: string | undefined;
    externalKey?: string | undefined;
    conversationId: string;
  },
  replyThreadId: string | null,
): string {
  return resolveMessagingThreadId(conversationChannelThreadId(conversation), replyThreadId);
}

export const TEAM_CHAT_THREAD_HISTORY_LIMIT = 50;
const THREAD_HISTORY_TIMEOUT_MS = 1_000;

export function createMessagingTeamChatHistory(
  messaging: MessagingSurface,
): ((message: TeamChatInboundMessage) => Promise<TeamChatInboundMessage[]>) | undefined {
  const fetchThreadHistory = messaging.fetchThreadHistory?.bind(messaging);
  if (!fetchThreadHistory) return undefined;
  return async (message) => {
    if (!message.replyThreadId) return [];
    const operationId = `team-chat-history:${randomUUID()}`;
    const history = await fetchThreadHistory(
      resolveMessagingThreadId(message.conversationId, message.replyThreadId),
      { before: message.eventId, limit: TEAM_CHAT_THREAD_HISTORY_LIMIT },
      {
        operationId,
        traceId: operationId,
        spaceId: "",
        userId: "",
        signal: AbortSignal.timeout(THREAD_HISTORY_TIMEOUT_MS),
      },
    );
    return history.flatMap((event) => {
      const mapped = toTeamChatInbound(event);
      if (!mapped) return [];
      return [
        {
          ...mapped,
          kind: "ambient" as const,
          workspaceId: message.workspaceId,
          conversationKey: message.conversationKey,
          conversationId: message.conversationId,
          conversationName: message.conversationName,
          replyThreadId: message.replyThreadId,
        },
      ];
    });
  };
}

export function createMessagingTeamChatSender(
  messaging: MessagingSurface,
): (request: TeamChatSendRequest) => Promise<TeamChatSendResult> {
  return async (request) => {
    const operationId = request.idempotencyKey
      ? `team-chat-send:${request.idempotencyKey}`
      : `team-chat-send:${randomUUID()}`;
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: new AbortController().signal,
    };
    const sent = await messaging.sendToThread(
      {
        threadId: resolveMessagingThreadId(request.conversationId, request.replyThreadId),
        body: request.content,
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      },
      context,
    );
    return { handle: sent.handle };
  };
}
