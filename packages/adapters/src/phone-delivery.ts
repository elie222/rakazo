import type {
  AdapterContext,
  JobPublisher,
  MessagingOutboundStatus,
  MessagingProvider,
} from "@rakazo/adapter-kit";
import { phoneDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { botMessageHopExhausted, nextBotMessageHop } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";

/**
 * Margin under the vendor's hard consecutive-outbound cap: past this many
 * DMs without a reply from the owner, mirror rows stay pending until the
 * next inbound resets the counter.
 */
export const PHONE_DM_OUTBOUND_CAP = 140;

/** Provider-send attempts before a mirrored row is declared lost. */
export const PHONE_OUTBOUND_MAX_ATTEMPTS = 5;

export interface PhoneDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingProvider;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
}

/**
 * Automatic mirror, not a send tool: every text-bearing bot message of a
 * phone run is copied into the uniform outbox and sent, so delivery does
 * not depend on prompt compliance. DM runs go to the owner's number;
 * channel runs go to the group with an attribution prefix and are fanned
 * out internally to peer approved bots (agent-to-agent traffic never
 * transits the messaging provider). Also drains pending outbox rows (invites and intros
 * are enqueued by the channels slice).
 */
export async function deliverPhoneOutbound(
  deps: PhoneDeliveryDeps,
  input: { runId?: string },
  context: AdapterContext,
): Promise<void> {
  if (input.runId) {
    await mirrorRun(deps, input.runId);
  }
  await drain(deps, context);
}

async function mirrorRun(deps: PhoneDeliveryDeps, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { sourceMessage: true },
  });
  if (run?.trigger !== "phone") return;
  const sourceBlocks = (run.sourceMessage?.blocks ?? []) as MessageBlock[];
  const channelBlock = sourceBlocks.find(
    (block): block is Extract<MessageBlock, { kind: "phone_channel_message" }> =>
      block.kind === "phone_channel_message",
  );
  if (channelBlock) {
    await mirrorChannelRun(deps, run, channelBlock);
    return;
  }

  const identity = await deps.prisma.phoneIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;

  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  const rows = messages
    .map((message) => ({
      idempotencyKey: `msg:${message.id}`,
      kind: "dm",
      toNumber: identity.phoneE164,
      body: extractText(message.blocks),
      sourceMessageId: message.id,
    }))
    .filter((row) => row.body);
  if (rows.length === 0) return;
  // Atomic dedupe: a concurrent phone.deliver for the same run loses on the
  // idempotencyKey unique key instead of throwing P2002.
  await deps.prisma.phoneOutbound.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Channel runs post to the group with an attribution prefix, then fan the
 * post out internally to peer approved bots: context only by default, a
 * waking run on @-mention, bounded by the shared bot-message hop budget.
 */
async function mirrorChannelRun(
  deps: PhoneDeliveryDeps,
  run: { id: string; botId: string },
  channelBlock: Extract<MessageBlock, { kind: "phone_channel_message" }>,
): Promise<void> {
  const identity = await deps.prisma.phoneIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;
  const channel = await deps.prisma.phoneChannel.findUnique({
    where: { id: channelBlock.channelId },
  });
  if (!channel) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: identity.userId },
    select: { name: true },
  });
  const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
  const fromLabel = `${firstName}'s agent`;

  const messages = (
    await deps.prisma.message.findMany({
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
    })
  )
    .map((message) => ({ message, text: extractText(message.blocks) }))
    .filter((entry) => entry.text);
  if (messages.length === 0) return;

  await deps.prisma.phoneOutbound.createMany({
    data: messages.map(({ message, text }) => ({
      idempotencyKey: `msg:${message.id}`,
      kind: "group",
      providerGroupId: channel.providerGroupId,
      body: `${fromLabel}: ${text}`,
      sourceMessageId: message.id,
    })),
    skipDuplicates: true,
  });

  const hop = nextBotMessageHop(channelBlock.hop);
  const peers = await deps.prisma.phoneChannelMember.findMany({
    where: {
      channelId: channel.id,
      status: "approved",
      identityId: { not: null },
      NOT: { identityId: identity.id },
    },
  });
  for (const { message, text } of messages) {
    for (const peer of peers) {
      const peerIdentity = await deps.prisma.phoneIdentity.findUnique({
        where: { id: peer.identityId! },
      });
      if (!peerIdentity) continue;
      const peerThread = await deps.prisma.thread.findFirst({
        where: { botId: peerIdentity.botId },
      });
      if (!peerThread) continue;
      const peerBot = await deps.prisma.bot.findUnique({
        where: { id: peerIdentity.botId },
        select: { name: true },
      });
      const block: MessageBlock = {
        kind: "phone_channel_message",
        channelId: channel.id,
        fromNumber: identity.phoneE164,
        fromLabel,
        text,
        hop,
      };
      const clientNonce = `phone-peer:${message.id}:${peerIdentity.botId}`;
      const mentioned = peerBot?.name
        ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(text)
        : false;
      if (mentioned && !botMessageHopExhausted(hop)) {
        const sent = await deps.events.sendUserMessage({
          spaceId: peerIdentity.spaceId,
          threadId: peerThread.id,
          botId: peerIdentity.botId,
          userId: peerIdentity.userId,
          blocks: [block],
          prompt: `[iMessage group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
          trigger: "phone",
          clientNonce,
        });
        if (sent.runId) {
          await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
            console.error("phone peer wake enqueue error", error);
          });
        }
        continue;
      }
      // Context only: the peer sees the post in history without a wake.
      const existing = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
      });
      if (existing) continue;
      const event = await deps.prisma.$transaction(async (tx) => {
        const created = await createThreadMessageInTransaction(tx, {
          threadId: peerThread.id,
          role: "user",
          blocks: [block],
          clientNonce,
        });
        return appendEventInTransaction(tx, {
          spaceId: peerIdentity.spaceId,
          threadId: peerThread.id,
          botId: peerIdentity.botId,
          type: "thread.message.created",
          payload: { messageId: created.id, role: "user", blocks: [block] },
        });
      });
      await deps.events.notify(peerThread.id, event.seq).catch(() => undefined);
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
 * (and delete the claim) between the pending check and sendDirect.
 * Only used for rare approval DMs, not for ordinary mirrored traffic.
 *
 * At-most-once: any failure after the provider call (or an ambiguous
 * transport error) keeps the outer claim as `sent` so drain does not
 * restore pending and duplicate the YES/NO DM. A lost invite is fine;
 * reconnect starts a fresh cycle.
 */
async function sendConnectInvite(
  deps: PhoneDeliveryDeps,
  row: { id: string; toNumber: string; body: string },
  pair: { requesterBotId: string; targetBotId: string },
  context: AdapterContext,
): Promise<"delivered" | "skipped" | "held"> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections
          WHERE "requesterBotId" = ${pair.requesterBotId}
            AND "targetBotId" = ${pair.targetBotId}
          FOR UPDATE
        `;
        if (locked[0]?.status !== "pending") {
          await tx.phoneOutbound.updateMany({
            where: { id: row.id },
            data: { status: "failed" },
          });
          return "skipped";
        }
        const outbound = await tx.phoneOutbound.findUnique({
          where: { id: row.id },
          select: { id: true },
        });
        if (!outbound) return "skipped";
        try {
          const sent = await deps.messaging.sendDirect(
            { to: row.toNumber, body: row.body },
            context,
          );
          await tx.phoneOutbound.updateMany({
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

async function drain(deps: PhoneDeliveryDeps, context: AdapterContext): Promise<void> {
  const now = new Date();
  const pending = await deps.prisma.phoneOutbound.findMany({
    where: {
      status: "pending",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
  });
  const groupsSupported = deps.messaging.describe().capabilities.groups;
  for (const row of pending) {
    // Claim before sending: concurrent drains (job keys are per runId) and
    // crash retries must never deliver the same iMessage twice.
    const claim = await deps.prisma.phoneOutbound.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sent", nextAttemptAt: null },
    });
    if (claim.count === 0) continue;
    try {
      if (row.kind === "group" || row.kind === "intro") {
        // A provider without group support (capabilities.groups false) can
        // never deliver these rows: fail them terminally instead of burning
        // the retry budget on calls that are known to be unsupported.
        if (!row.providerGroupId || !groupsSupported) {
          await deps.prisma.phoneOutbound.update({
            where: { id: row.id },
            data: { status: "failed" },
          });
          continue;
        }
        const sent = await deps.messaging.sendGroup(
          { groupId: row.providerGroupId, body: row.body },
          context,
        );
        await deps.prisma.phoneOutbound.update({
          where: { id: row.id },
          data: { providerHandle: sent.handle },
        });
        continue;
      }
      if (!row.toNumber) {
        await deps.prisma.phoneOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        continue;
      }
      const identity = await deps.prisma.phoneIdentity.findUnique({
        where: { phoneE164: row.toNumber },
      });
      if (identity && identity.outboundSinceInbound >= PHONE_DM_OUTBOUND_CAP) {
        // Cap holds are not failures: release the claim back to pending.
        await deps.prisma.phoneOutbound.update({
          where: { id: row.id },
          data: { status: "pending" },
        });
        continue;
      }
      const invitePair = connectInvitePair(row.idempotencyKey);
      if (invitePair) {
        const result = await sendConnectInvite(
          deps,
          { id: row.id, toNumber: row.toNumber, body: row.body },
          invitePair,
          context,
        );
        if (result === "delivered" && identity) {
          await deps.prisma.phoneIdentity.update({
            where: { id: identity.id },
            data: { outboundSinceInbound: { increment: 1 } },
          });
        }
        continue;
      }
      const sent = await deps.messaging.sendDirect({ to: row.toNumber, body: row.body }, context);
      await deps.prisma.phoneOutbound.updateMany({
        where: { id: row.id },
        data: { providerHandle: sent.handle },
      });
      if (identity) {
        await deps.prisma.phoneIdentity.update({
          where: { id: identity.id },
          data: { outboundSinceInbound: { increment: 1 } },
        });
      }
    } catch {
      // Transient provider errors go back to pending with a backed-off
      // retry; only an exhausted budget is terminal.
      const attempts = (row.attempts ?? 0) + 1;
      const exhausted = attempts >= PHONE_OUTBOUND_MAX_ATTEMPTS;
      const retryAt = exhausted ? null : new Date(Date.now() + phoneOutboundRetryDelayMs(attempts));
      await deps.prisma.phoneOutbound.updateMany({
        where: { id: row.id },
        data: {
          attempts,
          status: exhausted ? "failed" : "pending",
          nextAttemptAt: retryAt,
        },
      });
      if (!exhausted && retryAt) {
        // Propagate an enqueue failure: the phone.deliver job then fails and
        // the queue's own retry re-runs the drain. Swallowing it would strand
        // the row in pending — no reconciler reclaims phone_outbound rows.
        // Re-entry is safe: the row is pending again and nextAttemptAt keeps
        // other drains from racing the backoff window.
        await deps.jobs.enqueue(phoneDeliverJob(undefined, retryAt));
      }
    }
  }
}

/** Exponential backoff per attempt, capped at one minute. */
function phoneOutboundRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

/** Outbound status webhooks update outbox rows by provider handle. */
export async function applyPhoneOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
): Promise<void> {
  const status =
    event.status === "ERROR" || event.status === "DECLINED"
      ? "failed"
      : event.status === "SENT" || event.status === "DELIVERED"
        ? "sent"
        : null;
  if (!status) return;
  await prisma.phoneOutbound.updateMany({
    where: { providerHandle: event.handle },
    data: { status },
  });
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
