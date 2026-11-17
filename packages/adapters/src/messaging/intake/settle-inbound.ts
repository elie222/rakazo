import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import {
  messageBlockForArtifact,
  promptTextForAttachments,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { accountDeactivated, SpaceDeletionInProgressError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { wakeRun } from "../../runs/wakeups/wake-run.js";
import {
  inboundDeliveryClientNonce,
  messagingWakeIdempotencyKey,
} from "../../webhooks/inbound-delivery.js";
import type { MessagingDelivery, OutboundRow } from "../messaging-delivery.js";

/** The user message one inbound chat-app message becomes, so a second delivery of it is a no-op. */
export function messagingMessageClientNonce(provider: string, handle: string): string {
  return `messaging:${provider}:${handle}`;
}

/** The stored artifact of one file of an inbound chat-app message, by its place in the message. */
export function messagingAttachmentClientNonce(
  provider: string,
  handle: string,
  index: number,
): string {
  return `messaging-attachment:${provider}:${handle}:${index}`;
}

/**
 * The one reply a sender gets when files of their message did not reach the bot. Its key is the
 * message's, so the direct path and the backup job never both send it.
 */
export function filesNotReceivedReply(
  identityId: string,
  provider: string,
  handle: string,
): OutboundRow {
  return {
    idempotencyKey: `files-not-received:${provider}:${handle}`,
    kind: "dm",
    identityId,
    body: "Some files didn't arrive. Please send them again.",
  };
}

type Payload = BackgroundJobPayloads["messaging.inbound_settle"];

/**
 * The backup for a direct message whose files were still downloading when its process stopped:
 * posts the message with the files that were stored, marks every other one as not received,
 * wakes the bot, and tells the sender once. A message that already landed, here or through a
 * message routine, is left as it is.
 */
export async function settleInboundMessage(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "sendUserMessage">;
    jobs: Pick<JobPublisher, "enqueue">;
    delivery: Pick<MessagingDelivery, "record">;
  },
  payload: Payload,
): Promise<void> {
  const { provider, handle } = payload;
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { id: payload.identityId },
    select: { id: true, userId: true, spaceId: true, botId: true },
  });
  // Unlinked since, or the person was deactivated: nobody to deliver to.
  if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) return;
  const thread = await deps.prisma.thread.findFirst({
    where: { botId: identity.botId },
    select: { id: true },
  });
  if (!thread) return;

  const nonces = payload.attachments.map((_, index) =>
    messagingAttachmentClientNonce(provider, handle, index),
  );
  const stored = await deps.prisma.artifact.findMany({
    where: {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      groupId: null,
      clientNonce: { in: nonces },
    },
    select: { id: true, name: true, mimeType: true, size: true, clientNonce: true },
  });
  const byNonce = new Map(stored.map((artifact) => [artifact.clientNonce, artifact]));
  const artifacts = nonces.flatMap((nonce) => {
    const artifact = byNonce.get(nonce);
    return artifact ? [artifact] : [];
  });
  const missing = payload.attachments.flatMap((attachment, index) =>
    byNonce.has(nonces[index]!)
      ? []
      : [
          `[file: ${sanitizeMessagingLabel(attachment.name)} (not received — please send it again)]`,
        ],
  );

  // A message routine that took the message delivered it under its own nonce.
  const routed = await deps.prisma.message.findUnique({
    where: {
      threadId_clientNonce: {
        threadId: thread.id,
        clientNonce: inboundDeliveryClientNonce(
          "messaging",
          identity.botId,
          messagingWakeIdempotencyKey(provider, handle),
        ),
      },
    },
    select: { id: true },
  });
  if (!routed) {
    const body = [payload.text, ...missing].filter(Boolean).join("\n");
    try {
      const sent = await deps.events.sendUserMessage({
        spaceId: identity.spaceId,
        threadId: thread.id,
        botId: identity.botId,
        userId: identity.userId,
        authorUserId: identity.userId,
        blocks: [
          ...(body ? [{ kind: "text" as const, text: body }] : []),
          ...artifacts.map((artifact) => messageBlockForArtifact(artifact)),
        ],
        prompt: promptTextForAttachments(body, artifacts),
        trigger: "messaging",
        clientNonce: messagingMessageClientNonce(provider, handle),
      });
      if (sent.runId) await wakeRun(deps.jobs, sent.runId);
    } catch (error) {
      // A Space being deleted takes no messages; retrying would only fail again.
      if (!(error instanceof SpaceDeletionInProgressError)) throw error;
      getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
      return;
    }
  }
  if (missing.length > 0) {
    await deps.delivery.record({ identityId: identity.id }, [
      filesNotReceivedReply(identity.id, provider, handle),
    ]);
  }
}
