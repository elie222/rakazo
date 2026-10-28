import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { botMessageHopExhausted, nextBotMessageHop } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  CrossSpaceCommunicationBlockedError,
  createThreadMessageInTransaction,
  crossSpaceCommunicationAllowed,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";

/**
 * Margin under vendor consecutive-outbound caps (sendblue enforces one hard):
 * past this many DMs without a reply from the owner, mirror rows stay pending
 * until the next inbound resets the counter.
 */
export const MESSAGING_DM_OUTBOUND_CAP = 140;

/** Provider-send attempts before a mirrored row is declared lost. */
export const MESSAGING_OUTBOUND_MAX_ATTEMPTS = 5;

export interface MessagingDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingSurface;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  artifacts: Pick<ArtifactStore, "get">;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
};

/**
 * Automatic mirror, not a send tool, so delivery does not depend on prompt
 * compliance. Agent-to-agent fan-out stays internal and never transits the
 * messaging provider. Also drains outbox rows the channels slice enqueued.
 */
export async function deliverMessagingOutbound(
  deps: MessagingDeliveryDeps,
  input: { runId?: string },
  context: AdapterContext,
): Promise<void> {
  if (input.runId) {
    await mirrorMessagingOutbound(deps, input.runId);
  }
  await drain(deps, context);
}

export async function mirrorMessagingOutbound(
  deps: MessagingDeliveryDeps,
  runId: string,
): Promise<void> {
  await mirrorRun(deps, runId);
  await deps.prisma.run.updateMany({
    where: { id: runId, trigger: "messaging" },
    data: { messagingMirroredAt: new Date() },
  });
}

async function mirrorRun(deps: MessagingDeliveryDeps, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { sourceMessage: true },
  });
  if (!run) return;

  if (run.trigger === "messaging") {
    const sourceBlocks = (run.sourceMessage?.blocks ?? []) as MessageBlock[];
    const channelBlock = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
        block.kind === "channel_message",
    );
    if (channelBlock) {
      await mirrorChannelRun(deps, run, channelBlock);
      return;
    }
  } else if (run.trigger !== "bot_message") {
    // Mirror inbound messaging runs and delegated bot_message replies only.
    // Do not push in-app user/routine runs out to the linked chat.
    return;
  }

  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;

  // bot_message runs can carry the bot's user-facing reply after a delegate wake.
  // extractText only keeps kind:"text", so inter-bot chatter blocks never leak out.

  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  const sendsFiles = deps.messaging
    .platforms()
    .some((platform) => platform.provider === identity.provider && platform.capabilities.files);
  // One row per platform-sized part, then one per image or file, so a retry
  // re-sends only the parts that failed and never repeats delivered text.
  // Explicit createdAt keeps the parts in order for the drain.
  const createdAt = Date.now();
  const rows = messages
    .flatMap((message) => {
      const body = extractText(message.blocks);
      const parts = body ? splitOutboundBody(identity.provider, body) : [];
      return [
        ...parts.map((part, index) => ({
          idempotencyKey: index === 0 ? `msg:${message.id}` : `msg:${message.id}:${index + 1}`,
          kind: "dm",
          identityId: identity.id,
          body: part,
          sourceMessageId: message.id,
        })),
        ...(sendsFiles ? extractArtifactIds(message.blocks) : []).map((artifactId) => ({
          idempotencyKey: `msg:${message.id}:file:${artifactId}`,
          kind: "dm",
          identityId: identity.id,
          body: "",
          sourceMessageId: message.id,
        })),
      ];
    })
    .map((row, index) => ({ ...row, createdAt: new Date(createdAt + index) }));
  if (rows.length === 0) return;
  // Atomic dedupe: a concurrent messaging.deliver for the same run loses on
  // the idempotencyKey unique key instead of throwing P2002.
  await deps.prisma.messagingOutbound.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Channel runs post to the group with an attribution prefix, then fan the
 * post out internally to peer approved bots: context only by default, a
 * waking run on @-mention, bounded by the shared bot-message hop budget.
 */
async function mirrorChannelRun(
  deps: MessagingDeliveryDeps,
  run: { id: string; botId: string },
  channelBlock: Extract<MessageBlock, { kind: "channel_message" }>,
): Promise<void> {
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;
  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { id: channelBlock.channelId },
  });
  if (!channel) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: identity.userId },
    select: { name: true },
  });
  const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
  const fromLabel = `${firstName}'s agent`;

  const replies = await deps.prisma.message.findMany({
    select: { id: true, blocks: true },
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  // Ask answers are entered privately in the app. Check the same snapshot as
  // the replies so a resumed run cannot publish an answer-influenced response.
  if (
    replies.some((message) =>
      (message.blocks as MessageBlock[]).some(
        (block) => block.kind === "ask" && block.status === "answered",
      ),
    )
  )
    return;
  const messages = replies
    .map((message) => ({ message, text: extractText(message.blocks) }))
    .filter((entry) => entry.text);
  if (messages.length === 0) return;

  await deps.prisma.messagingOutbound.createMany({
    data: messages.map(({ message, text }) => ({
      idempotencyKey: `msg:${message.id}`,
      kind: "group",
      threadId: channel.threadId,
      body: `${fromLabel}: ${text}`,
      sourceMessageId: message.id,
    })),
    skipDuplicates: true,
  });

  const hop = nextBotMessageHop(channelBlock.hop);
  const peers = await deps.prisma.messagingChannelMember.findMany({
    where: {
      channelId: channel.id,
      status: "approved",
      identityId: { not: null },
      NOT: { identityId: identity.id },
    },
  });
  // Peer bots belong to other members, usually in other Spaces.
  await runAsSystem("fan a group post out to peer bots in other Spaces", () =>
    fanOutToPeers(deps, { identity, channel, channelBlock, fromLabel, hop, peers, messages }),
  );
}

async function fanOutToPeers(
  deps: MessagingDeliveryDeps,
  {
    identity,
    channel,
    channelBlock,
    fromLabel,
    hop,
    peers,
    messages,
  }: {
    identity: { provider: string; address: string; botId: string };
    channel: { id: string; name: string | null };
    channelBlock: Extract<MessageBlock, { kind: "channel_message" }>;
    fromLabel: string;
    hop: number;
    peers: Array<{ identityId: string | null }>;
    messages: Array<{ message: { id: string }; text: string }>;
  },
): Promise<void> {
  for (const { message, text } of messages) {
    for (const peer of peers) {
      const peerIdentity = await deps.prisma.messagingIdentity.findUnique({
        where: { id: peer.identityId! },
      });
      if (!peerIdentity) continue;
      if (!(await crossSpaceCommunicationAllowed(deps.prisma, identity.botId, peerIdentity.botId)))
        continue;
      const peerThread = await deps.prisma.thread.findFirst({
        where: { botId: peerIdentity.botId },
      });
      if (!peerThread) continue;
      const peerBot = await deps.prisma.bot.findUnique({
        where: { id: peerIdentity.botId },
        select: { name: true },
      });
      const block: MessageBlock = {
        kind: "channel_message",
        provider: identity.provider,
        ...(channelBlock.transport ? { transport: channelBlock.transport } : {}),
        channelId: channel.id,
        fromAddress: identity.address,
        fromLabel,
        text,
        hop,
      };
      const clientNonce = `messaging-peer:${message.id}:${peerIdentity.botId}`;
      const mentioned = peerBot?.name
        ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(text)
        : false;
      if (mentioned && !botMessageHopExhausted(hop)) {
        const sent = await deps.events
          .sendUserMessage({
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            userId: peerIdentity.userId,
            blocks: [block],
            prompt: `[Group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
            trigger: "messaging",
            clientNonce,
            crossSpaceSenderBotId: identity.botId,
          })
          .catch((error: unknown) => {
            if (error instanceof CrossSpaceCommunicationBlockedError) return null;
            throw error;
          });
        if (sent?.runId) {
          await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
            getLogger().error("messaging peer wake enqueue error", error);
          });
        }
        continue;
      }
      // Context only: the peer sees the post in history without a wake.
      const existing = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
      });
      if (existing) continue;
      const event = await deps.prisma
        .$transaction(async (tx) => {
          const created = await createThreadMessageInTransaction(tx, {
            threadId: peerThread.id,
            role: "user",
            blocks: [block],
            clientNonce,
          });
          if (!(await crossSpaceCommunicationAllowed(tx, identity.botId, peerIdentity.botId)))
            throw new CrossSpaceCommunicationBlockedError();
          return appendEventInTransaction(tx, {
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            type: "thread.message.created",
            payload: { messageId: created.id, role: "user", blocks: [block] },
          });
        })
        .catch((error: unknown) => {
          if (error instanceof CrossSpaceCommunicationBlockedError) return null;
          throw error;
        });
      if (event) await deps.events.notify(peerThread.id, event.seq).catch(() => undefined);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `connect:{requesterBotId}:{targetBotId}` — agent-connection approval DMs. */
function connectInvitePair(
  idempotencyKey: string,
): { requesterBotId: string; targetBotId: string } | null {
  const match = /^connect:([^:]+):([^:]+)$/.exec(idempotencyKey);
  if (!match) return null;
  return { requesterBotId: match[1]!, targetBotId: match[2]! };
}

/**
 * Deliver a connect invite while holding the connection row lock.
 * Revoke's status update blocks behind this lock, so it cannot commit
 * (and delete the claim) between the pending check and the send.
 * Only used for rare approval DMs, not for ordinary mirrored traffic.
 *
 * At-most-once: any failure after the provider call (or an ambiguous
 * transport error) keeps the outer claim as `sent` so drain does not
 * restore pending and duplicate the YES/NO DM. A lost invite is fine;
 * reconnect starts a fresh cycle.
 */
async function sendConnectInvite(
  deps: MessagingDeliveryDeps,
  row: { id: string; body: string },
  threadId: string,
  pair: { requesterBotId: string; targetBotId: string },
  context: AdapterContext,
): Promise<"delivered" | "skipped" | "held"> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const communicationAllowed = await crossSpaceCommunicationAllowed(
          tx,
          pair.requesterBotId,
          pair.targetBotId,
        );
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections
          WHERE "requesterBotId" = ${pair.requesterBotId}
            AND "targetBotId" = ${pair.targetBotId}
          FOR UPDATE
        `;
        if (locked[0]?.status !== "pending" || !communicationAllowed) {
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { status: "failed" },
          });
          return "skipped";
        }
        const outbound = await tx.messagingOutbound.findUnique({
          where: { id: row.id },
          select: { id: true },
        });
        if (!outbound) return "skipped";
        try {
          const sent = await deps.messaging.sendToThread({ threadId, body: row.body }, context);
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { providerHandle: sent.handle },
          });
          return "delivered";
        } catch {
          // Provider error or lost response is ambiguous without an
          // idempotency key. Do not ask drain to retry.
          return "held";
        }
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch {
    // Lock/timeout after a possible accept: keep the outer claim as sent.
    return "held";
  }
}

async function drain(deps: MessagingDeliveryDeps, context: AdapterContext): Promise<void> {
  const now = Date.now();
  const pending = await deps.prisma.messagingOutbound.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  // Keep each conversation in order: a row waiting out a backoff, held at
  // the cap, or failing now holds back the later rows to the same place.
  const held = new Set<string>();
  for (const row of pending) {
    const destination = row.identityId ?? row.threadId ?? row.id;
    if (held.has(destination)) continue;
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) {
      held.add(destination);
      continue;
    }
    // A later part of a split reply waits until the earlier parts are out;
    // another drain may hold one of them in flight.
    if (await hasUndeliveredEarlierPart(deps, row, now)) {
      held.add(destination);
      continue;
    }
    // Claim before sending: concurrent drains (job keys are per runId) and
    // crash retries must never deliver the same message twice.
    const claim = await deps.prisma.messagingOutbound.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sent", nextAttemptAt: null },
    });
    if (claim.count === 0) continue;
    let attachmentName: string | null = null;
    let accepted = false;
    try {
      if (row.kind === "group" || row.kind === "intro") {
        if (!row.threadId) {
          await deps.prisma.messagingOutbound.update({
            where: { id: row.id },
            data: { status: "failed" },
          });
          continue;
        }
        const sent = await deps.messaging.sendToThread(
          { threadId: row.threadId, body: row.body },
          context,
        );
        accepted = true;
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { providerHandle: sent.handle },
        });
        continue;
      }
      const identity = row.identityId
        ? await deps.prisma.messagingIdentity.findUnique({ where: { id: row.identityId } })
        : null;
      if (!identity) {
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        continue;
      }
      // Sendblue's consecutive-outbound vendor cap; other providers have no
      // equivalent limit, so do not hold Slack/WhatsApp/Telegram DMs.
      if (
        identity.provider === "sendblue" &&
        identity.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP
      ) {
        // Cap holds are not failures: release the claim back to pending.
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "pending" },
        });
        held.add(destination);
        continue;
      }
      const threadId = await resolveDirectThread(deps, identity, context);
      const invitePair = connectInvitePair(row.idempotencyKey);
      if (invitePair) {
        const result = await sendConnectInvite(
          deps,
          { id: row.id, body: row.body },
          threadId,
          invitePair,
          context,
        );
        if (result === "delivered") {
          accepted = true;
          await deps.prisma.messagingIdentity.update({
            where: { id: identity.id },
            data: { outboundSinceInbound: { increment: 1 } },
          });
        }
        continue;
      }
      let attachment: MessagingOutboundAttachment | undefined;
      const artifactId = fileArtifactId(row.idempotencyKey);
      if (artifactId) {
        // Scoped to the identity's Space: the drain runs across every Space.
        const artifact = await deps.prisma.artifact.findFirst({
          where: { id: artifactId, spaceId: identity.spaceId },
          select: { name: true, mimeType: true, storageKey: true, userId: true },
        });
        if (!artifact) {
          // Deleted since the reply was mirrored, or not in this Space.
          await deps.prisma.messagingOutbound.update({
            where: { id: row.id },
            data: { status: "failed" },
          });
          continue;
        }
        attachmentName = artifact.name;
        const data = await deps.artifacts.get(artifact.storageKey, {
          ...context,
          spaceId: identity.spaceId,
          userId: artifact.userId,
        });
        attachment = { name: artifact.name, mimeType: artifact.mimeType, data };
      }
      const sent = await deps.messaging.sendToThread(
        { threadId, body: row.body, ...(attachment ? { attachment } : {}) },
        context,
      );
      accepted = true;
      await deps.prisma.messagingOutbound.updateMany({
        where: { id: row.id },
        data: { providerHandle: sent.handle },
      });
      await deps.prisma.messagingIdentity.update({
        where: { id: identity.id },
        data: { outboundSinceInbound: { increment: 1 } },
      });
    } catch (error) {
      if (accepted) {
        // Keep the sent claim even if saving the handle or counter fails.
        getLogger().error("messaging outbound bookkeeping error", error);
        continue;
      }
      // Transient provider errors go back to pending with a backed-off
      // retry (no sooner than the provider's retry-after); a permanent error
      // or an exhausted budget is terminal.
      held.add(destination);
      const failure = error instanceof MessagingSendError ? error : null;
      const attempts = (row.attempts ?? 0) + 1;
      const exhausted = failure?.permanent || attempts >= MESSAGING_OUTBOUND_MAX_ATTEMPTS;
      const delayMs = Math.max(messagingOutboundRetryDelayMs(attempts), failure?.retryAfterMs ?? 0);
      const retryAt = exhausted ? null : new Date(Date.now() + delayMs);
      const outcome = {
        where: { id: row.id },
        data: {
          attempts,
          status: exhausted ? "failed" : "pending",
          nextAttemptAt: retryAt,
        },
      };
      if (exhausted && attachmentName) {
        // The reply's text went out on its own rows; say the file did not
        // follow instead of dropping it silently. Saved with the failure so
        // one cannot land without the other, keyed so it is queued once, and
        // given the file's place so later replies wait behind it.
        const name = attachmentName;
        await deps.prisma.$transaction(async (tx) => {
          await tx.messagingOutbound.updateMany(outcome);
          await tx.messagingOutbound.createMany({
            data: [
              {
                idempotencyKey: `${row.idempotencyKey}:notice`,
                kind: row.kind,
                identityId: row.identityId,
                threadId: row.threadId,
                body: `Could not send "${name}".`,
                sourceMessageId: row.sourceMessageId,
                createdAt: row.createdAt,
              },
            ],
            skipDuplicates: true,
          });
        });
        await deps.jobs.enqueue(messagingDeliverJob());
        continue;
      }
      await deps.prisma.messagingOutbound.updateMany(outcome);
      if (!exhausted && retryAt) {
        // Propagate an enqueue failure: the messaging.deliver job then fails
        // and the queue's own retry re-runs the drain. Swallowing it would
        // strand the row in pending — no reconciler reclaims outbox rows.
        // Re-entry is safe: the row is pending again and nextAttemptAt keeps
        // other drains from racing the backoff window.
        await deps.jobs.enqueue(messagingDeliverJob(undefined, retryAt));
      }
    }
  }
}

/** A claimed part still without a handle after this long is treated as abandoned. */
const MESSAGING_PART_IN_FLIGHT_MS = 2 * 60_000;

async function hasUndeliveredEarlierPart(
  deps: MessagingDeliveryDeps,
  row: { idempotencyKey: string; sourceMessageId: string | null; createdAt: Date },
  now: number,
): Promise<boolean> {
  if (!row.sourceMessageId || row.idempotencyKey === `msg:${row.sourceMessageId}`) return false;
  const earlier = await deps.prisma.messagingOutbound.findFirst({
    where: {
      sourceMessageId: row.sourceMessageId,
      createdAt: { lt: row.createdAt },
      OR: [
        { status: "pending" },
        {
          status: "sent",
          providerHandle: null,
          updatedAt: { gt: new Date(now - MESSAGING_PART_IN_FLIGHT_MS) },
        },
      ],
    },
    select: { id: true },
  });
  return earlier !== null;
}

/**
 * DM rows address the identity, not a thread: the conversation id is learned
 * from inbound webhooks and cached, with a provider lookup as fallback for
 * identities that predate the cache (or the multi-platform migration).
 */
async function resolveDirectThread(
  deps: MessagingDeliveryDeps,
  identity: IdentityRow,
  context: AdapterContext,
): Promise<string> {
  if (identity.dmThreadId) return identity.dmThreadId;
  const threadId = await deps.messaging.openDirectThread(
    identity.provider,
    identity.address,
    context,
  );
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { dmThreadId: threadId },
  });
  return threadId;
}

function messagingOutboundRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

/** Outbound status webhooks update outbox rows by provider handle. */
export async function applyMessagingOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
): Promise<void> {
  const status = ["ERROR", "DECLINED", "FAILED"].includes(event.status)
    ? "failed"
    : ["SENT", "DELIVERED", "READ"].includes(event.status)
      ? "sent"
      : null;
  if (!status) return;
  await prisma.messagingOutbound.updateMany({
    where: { providerHandle: event.handle },
    data: { status },
  });
}

/** The artifact a reply's file row sends, from its `msg:<message>:file:<artifact>` key. */
function fileArtifactId(idempotencyKey: string): string | null {
  return /^msg:[^:]+:file:([^:]+)$/.exec(idempotencyKey)?.[1] ?? null;
}

/** Artifacts of the message's image and file blocks, in block order. */
function extractArtifactIds(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; artifactId?: unknown } | null) =>
    (block?.kind === "image" || block?.kind === "file") && typeof block.artifactId === "string"
      ? [block.artifactId]
      : [],
  );
}

function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(
      (block): block is { kind: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { kind?: string }).kind === "text" &&
        typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
