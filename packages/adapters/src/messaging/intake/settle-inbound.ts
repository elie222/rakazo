import type { BackgroundJobPayloads, JobPublisher, JobQueueOrder } from "@rakazo/adapter-kit";
import { messagingInboundSettleJobKey, messagingInboundSettleQueue } from "@rakazo/adapter-kit";
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  isAllowedAttachmentMimeType,
} from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  messageBlockForArtifact,
  promptTextForAttachments,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { ContentLocation, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  accountDeactivated,
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
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
 * The line that stands in a message for a file the bot never got, saying why when the path knows.
 * The sender chose the name, so it is sanitized before it can reach a prompt.
 */
export function unavailableFileLine(name: string, reason?: string): string {
  return `[file: ${sanitizeMessagingLabel(name)} (unavailable${reason ? `: ${reason}` : ""})]`;
}

/**
 * The type an inbound file is kept as: the type its chat app reported, without parameters (a
 * voice note's "audio/ogg; codecs=opus"), or the one its name implies.
 */
export function inboundAttachmentMimeType(name: string, reportedType: string): string {
  const base = reportedType.split(";")[0]?.trim().toLowerCase() || reportedType;
  return inferAttachmentMimeType(name, base) ?? base;
}

/**
 * Why the store would refuse an inbound file before downloading it, as the direct path does:
 * a type the bot cannot take, or a reported size over the upload limit.
 */
function refusal(
  attachment: { name: string; mimeType: string; size?: number },
  maxBytes: number,
): "unsupported type" | "too large" | undefined {
  const name = attachment.name.slice(0, ARTIFACT_NAME_MAX_LENGTH);
  if (!isAllowedAttachmentMimeType(inboundAttachmentMimeType(name, attachment.mimeType))) {
    return "unsupported type";
  }
  if ((attachment.size ?? 0) > maxBytes) return "too large";
  return undefined;
}

/**
 * The one reply a sender gets when files of their message did not reach the bot, whatever the
 * reason. Its key is the message's, so the direct path and the backup job never both send it.
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
    body: "Some files couldn't be received.",
  };
}

type Payload = BackgroundJobPayloads["messaging.inbound_settle"];

/** The settle job's text, bound to its job and sender so a copy anywhere else fails to open. */
function settleTextLocation(
  job: Pick<Payload, "provider" | "handle" | "identityId">,
): ContentLocation {
  return {
    table: "graphile_worker.jobs",
    column: "payload.text",
    rowId: messagingInboundSettleJobKey(job.provider, job.handle),
    owner: job.identityId,
  };
}

/**
 * What the person wrote, for their message's settle job: sealed under their Space's current key,
 * since the job queue's table sits outside content encryption. It stays plaintext only where
 * content encryption is off.
 */
export async function sealSettleText(
  prisma: PrismaClient,
  spaceId: string,
  job: Pick<Payload, "provider" | "handle" | "identityId">,
  text: string,
): Promise<string> {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption?.ring.encryptWrites) return text;
  return encryptText(await encryption.ring.current(spaceId), settleTextLocation(job), text);
}

/** The settle job's text as the person wrote it; only a key of their Space opens it. */
async function openSettleText(
  prisma: PrismaClient,
  spaceId: string,
  payload: Payload,
): Promise<string> {
  const keyId = ciphertextKeyId(payload.text);
  if (!keyId) return payload.text;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Inbound message encryption is unavailable");
  const key = await encryption.ring.byId(keyId);
  if (key.spaceId !== spaceId) {
    throw new ContentDecryptionError("Inbound message names another Space's key");
  }
  return decryptText(key, settleTextLocation(payload), payload.text);
}

/**
 * The backup for a direct message whose files were still downloading when its process stopped:
 * posts the message with the files that were stored, marks every other one with why it is
 * missing, wakes the bot unless a stop quieted the message, and tells the sender once. A message
 * that already landed, here or through a message routine, is left as it is. Then the sender's
 * jobs that waited only for it are due now.
 */
export async function settleInboundMessage(deps: SettleDeps, payload: Payload): Promise<void> {
  await settleMessage(deps, payload);
  await deps.prisma.$transaction((tx) =>
    deps.jobs.releaseFollowersIn(
      tx,
      messagingInboundSettleQueue(payload.identityId),
      messagingInboundSettleJobKey(payload.provider, payload.handle),
    ),
  );
}

type SettleDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage">;
  jobs: Pick<JobPublisher, "enqueue"> & Pick<JobQueueOrder, "releaseFollowersIn">;
  delivery: Pick<MessagingDelivery, "record">;
  /** The upload limit the direct path refuses larger files by. */
  maxUploadSizeBytes?: number;
};

async function settleMessage(deps: SettleDeps, payload: Payload): Promise<void> {
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
  const text = await openSettleText(deps.prisma, identity.spaceId, payload);

  // Files past the cap were never downloaded, so only those before it can have been stored.
  const nonces = payload.attachments
    .slice(0, ATTACHMENT_MAX_COUNT)
    .map((_, index) => messagingAttachmentClientNonce(provider, handle, index));
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
  const maxBytes = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  const missing = payload.attachments.flatMap((attachment, index) => {
    const nonce = nonces[index];
    if (nonce && byNonce.has(nonce)) return [];
    const reason = (nonce && refusal(attachment, maxBytes)) || "not received";
    return [unavailableFileLine(attachment.name, reason)];
  });

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
    const body = [text, ...missing].filter(Boolean).join("\n");
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
        // A stop sent after it: the message joins the chat and starts no turn.
        ...(payload.quiet ? { createRun: false } : {}),
      });
      if (sent.runId && !payload.quiet) await wakeRun(deps.jobs, sent.runId);
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
