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
export function toTeamChatInbound(
  event: MessagingInboundMessage,
): TeamChatInboundMessage | null {
  const mediaLine = event.mediaUrl?.trim() ? `\n${event.mediaUrl.trim()}` : "";
  const content = `${event.content}${mediaLine}`.trim();
  if (!content) return null;

  const kind: TeamChatMessageKind = event.isDirect
    ? "direct"
    : (event.kind ??
      (looksLikeMention(event.content, event.channelName) ? "mention" : "ambient"));

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
  };
}

function looksLikeMention(content: string, channelName: string | null): boolean {
  if (channelName == null && !content.includes("@")) return false;
  return /(^|\s)@[\w.-]+/.test(content);
}

/** Outbound sender that posts through the existing MessagingSurface. */
export function createMessagingTeamChatSender(
  messaging: MessagingSurface,
): (request: TeamChatSendRequest) => Promise<TeamChatSendResult> {
  return async (request) => {
    const operationId = `team-chat-send:${randomUUID()}`;
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: new AbortController().signal,
    };
    const sent = await messaging.sendToThread(
      { threadId: request.conversationId, body: request.content },
      context,
    );
    return { handle: sent.handle };
  };
}
