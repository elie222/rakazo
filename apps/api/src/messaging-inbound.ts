import type { JobPublisher, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { parseMessagingCommand, sanitizeMessagingLabel } from "@rakazo/core";
import type {
  MessagingIdentityRequest,
  Prisma,
  PrismaClient,
  ProvisionedMessagingIdentity,
  SignupPolicyEnv,
  ThreadEvents,
} from "@rakazo/db";
import {
  createThreadMessage,
  normalizeMessagingLinkCode,
  redeemMessagingLinkCode,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export interface MessagingInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  provision: (
    request: MessagingIdentityRequest,
    env: SignupPolicyEnv,
  ) => Promise<ProvisionedMessagingIdentity>;
  /**
   * Poke-style open line: unknown senders auto-provision their own account.
   * Off by default — strangers' runs would bill the deployment model key.
   */
  openSignup: boolean;
  signupPolicy: SignupPolicyEnv;
  /**
   * Best-effort "…" bubbles shown to a 1:1 sender while their run executes.
   * Cosmetic only — callers must catch failures; groups never get it.
   */
  typing?: (threadId: string) => Promise<void>;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 messages are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE owner commands).
 * Group messages drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createMessagingInboundHandler(deps: MessagingInboundDeps) {
  return async (event: MessagingInboundMessage): Promise<void> => {
    if (!event.isDirect) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, event);
  };
}

async function handleDirectEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  // Inbound media arrives as a CDN URL (often expiring); no artifact
  // ingestion in v1, so it rides along as text.
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");

  const where = { provider_address: { provider: event.provider, address: event.from } } as const;
  const existing = await deps.prisma.messagingIdentity.findUnique({ where });
  if (existing) {
    // Any reply — even a content-free reaction — ends the consecutive-
    // outbound streak, but only real text wakes the bot. The conversation
    // id is refreshed from the webhook so outbound always has a thread.
    await deps.prisma.messagingIdentity.update({
      where: { id: existing.id },
      data: { outboundSinceInbound: 0, lastInboundAt: new Date(), dmThreadId: event.threadId },
    });
    if (!text) return;
    // Owner commands are only parsed in the verified 1:1 conversation.
    const command = parseMessagingCommand(event.content);
    if (command && (await applyOwnerCommand(deps, existing, command))) return;
    // A linked sender pasting a fresh code re-points this address at another
    // of their bots (only their own codes apply).
    if (await tryRedeemLinkCode(deps, event)) return;
  } else {
    // Unlinked senders: a valid link code binds this address to its issuer's
    // account and bot; otherwise the line is silent unless the deployment
    // explicitly runs as an open Poke-style signup line.
    if (await tryRedeemLinkCode(deps, event)) return;
    if (!deps.openSignup) return;
    // Never provision a full account for a reaction or empty payload.
    if (!text) return;
  }

  let ids: ProvisionedMessagingIdentity;
  if (existing) {
    const thread = await deps.prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`messaging identity ${existing.id} has no thread`);
    ids = {
      provider: existing.provider,
      address: existing.address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    ids = await deps.provision(
      {
        provider: event.provider,
        address: event.from,
        dmThreadId: event.threadId,
        displayName: event.fromLabel ? sanitizeMessagingLabel(event.fromLabel) : null,
      },
      deps.signupPolicy,
    );
  }

  const sent = await deps.events.sendUserMessage({
    spaceId: ids.spaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "messaging",
    clientNonce: `messaging:${event.provider}:${event.handle}`,
  });
  if (sent.runId) {
    // Typing bubbles only make sense once a reply is actually coming. Fire
    // before the enqueue so they land ahead of a fast reply, and never await:
    // a stalled vendor typing call must not hold the webhook open. The bubbles
    // clear on their own after a short display window or when the reply
    // arrives, so long runs simply outlive them.
    void deps.typing?.(event.threadId).catch((error) => {
      getLogger().error("messaging typing indicator error", error);
    });
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("messaging inbound run enqueue error", error);
    });
  }
}

/**
 * Returns true when the message was exactly a link code that redeemed:
 * the address is now bound to the issuer's chosen bot and a confirmation
 * DM is on its way. An invalid or expired code falls through silently —
 * for linked senders it reads as a normal message, for strangers nothing
 * happens (no oracle, no reply spam).
 */
async function tryRedeemLinkCode(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<boolean> {
  const code = normalizeMessagingLinkCode(event.content);
  if (!code) return false;
  const redeemed = await redeemMessagingLinkCode(deps.prisma, {
    code,
    provider: event.provider,
    address: event.from,
    dmThreadId: event.threadId,
  });
  if (!redeemed) return false;
  const bot = await deps.prisma.bot.findUnique({
    where: { id: redeemed.botId },
    select: { name: true },
  });
  await enqueueConfirmation(
    deps,
    { id: redeemed.identityId },
    redeemed.confirmationKey,
    `Linked — messages here now reach "${bot?.name ?? "your agent"}".`,
  );
  return true;
}

/** Returns true when the command matched a pending item and was handled. */
async function applyOwnerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  command: "approve" | "decline" | "leave",
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    const { count } = await deps.prisma.messagingChannelMember.updateMany({
      where: { id: membership.id, status: "approved" },
      data: { status: "left" },
    });
    // State changed under us (e.g. swept out and re-invited): treat the
    // text as a normal message rather than overwriting the newer state.
    if (count === 0) return false;
    await enqueueConfirmation(
      deps,
      identity,
      `command:leave:${membership.id}`,
      "You've left the channel. Your agent will no longer post there. The group chat itself is unchanged.",
    );
    return true;
  }

  const membership = await deps.prisma.messagingChannelMember.findFirst({
    where: { identityId: identity.id, status: "invited" },
    orderBy: { updatedAt: "desc" },
  });
  const connection = await deps.prisma.agentConnection.findFirst({
    where: { targetBotId: identity.botId, status: "pending" },
    orderBy: { updatedAt: "desc" },
  });
  // YES/NO answers whichever pending item is newest, channel invite or
  // agent connection.
  const target =
    membership && (!connection || membership.updatedAt >= connection.updatedAt)
      ? ({ kind: "channel", membership } as const)
      : connection
        ? ({ kind: "connection", connection } as const)
        : null;
  if (!target) return false;
  const approved = command === "approve";

  if (target.kind === "channel") {
    const key = `command:${command}:${target.membership.id}`;
    const claimed = await deps.prisma.$transaction(async (tx) => {
      // The claim holds the membership row lock through commit, so the
      // participant sweep can never interleave with the confirmation write.
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) return false;
      await writeConfirmation(
        tx,
        identity,
        key,
        approved
          ? "You're in. Your agent will now see and reply to that group."
          : "No problem, your agent will stay out of that group.",
      );
      return true;
    });
    if (!claimed) return false;
    await enqueueDeliverJob(deps);
    return true;
  }

  const connectedKey = `command:connected:${target.connection.id}`;
  const requesterIdentity = approved
    ? await deps.prisma.messagingIdentity.findUnique({
        where: { botId: target.connection.requesterBotId },
      })
    : null;
  const key = `command:${command}:${target.connection.id}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    // The claim holds the connection row lock through commit, so a revoke
    // can never interleave with the confirmation writes.
    const { count } = await tx.agentConnection.updateMany({
      where: { id: target.connection.id, status: "pending" },
      data: { status: approved ? "approved" : "declined" },
    });
    // Revoked or answered elsewhere since the read: not ours to write.
    if (count === 0) return false;
    await writeConfirmation(
      tx,
      identity,
      key,
      approved
        ? "Connection approved. Your agents can now message each other."
        : "Connection declined.",
    );
    if (requesterIdentity) {
      await writeConfirmation(
        tx,
        requesterIdentity,
        connectedKey,
        "Your connection request was accepted. Your agents can now message each other.",
      );
    }
    return true;
  });
  if (!claimed) return false;
  await enqueueDeliverJob(deps);
  return true;
}

/** Delete-then-insert inside the caller's claim transaction: the prior
 * cycle's row must not suppress the new confirmation. */
async function writeConfirmation(
  tx: Pick<Prisma.TransactionClient, "messagingOutbound">,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
  await tx.messagingOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    skipDuplicates: true,
  });
}

async function enqueueDeliverJob(deps: MessagingInboundDeps): Promise<void> {
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging confirmation enqueue error", error);
  });
}

async function enqueueConfirmation(
  deps: MessagingInboundDeps,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  // Keys are stable per membership/connection across approval cycles; clear
  // the prior cycle's row or skipDuplicates would swallow the new text.
  await deps.prisma.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
  await deps.prisma.messagingOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    skipDuplicates: true,
  });
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging confirmation enqueue error", error);
  });
}

async function handleChannelEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const channelName = event.channelName ? sanitizeMessagingLabel(event.channelName) : null;
  const channel = await deps.prisma.messagingChannel.upsert({
    where: { threadId: event.threadId },
    create: { provider: event.provider, threadId: event.threadId, name: channelName },
    update: channelName ? { name: channelName } : {},
  });

  const participants = [...event.participants];
  if (!participants.includes(event.from)) participants.push(event.from);

  let hasUnlinked = false;
  for (const address of participants) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider: event.provider, address } },
    });
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address } },
    });
    if (member) {
      // Compare against the current identity, not just null: unlinking
      // deletes the identity row but leaves this FK-free column pointing at
      // the dead id, so a re-link would otherwise never reattach and the
      // member would sit in the channel unreachable by every lookup.
      if (identity && member.identityId !== identity.id) {
        await deps.prisma.messagingChannelMember.update({
          where: { id: member.id },
          data: { identityId: identity.id },
        });
        if (member.status === "invited") await inviteMember(deps, channel, identity);
      }
      if (member.status === "left") {
        // Back in the group: restart the approval cycle.
        await deps.prisma.messagingChannelMember.update({
          where: { id: member.id },
          data: { status: "invited" },
        });
        if (identity) await inviteMember(deps, channel, identity);
      }
      if (!identity) hasUnlinked = true;
      continue;
    }
    // Upsert, not create: concurrent group webhooks race on the unique key.
    await deps.prisma.messagingChannelMember.upsert({
      where: { channelId_address: { channelId: channel.id, address } },
      create: {
        channelId: channel.id,
        address,
        identityId: identity?.id ?? null,
        status: "invited",
      },
      update: {},
    });
    if (identity) await inviteMember(deps, channel, identity);
    else hasUnlinked = true;
  }

  // Someone removed from the group must stop receiving its content.
  // A webhook without a participants roster says nothing about membership —
  // never sweep on partial data.
  if (event.participants.length > 0) {
    await deps.prisma.messagingChannelMember.updateMany({
      where: {
        channelId: channel.id,
        address: { notIn: participants },
        status: { in: ["invited", "approved"] },
      },
      data: { status: "left" },
    });
  }

  if (hasUnlinked && !channel.introPostedAt) {
    await deps.prisma.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `intro:${channel.id}`,
          kind: "intro",
          threadId: channel.threadId,
          body: "Hi. This line hosts Rakazo personal agents. Some people in this group haven't messaged it yet; send any message to this line first if you want your own agent here.",
        },
      ],
      skipDuplicates: true,
    });
    await deps.prisma.messagingChannel.update({
      where: { id: channel.id },
      data: { introPostedAt: new Date() },
    });
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("messaging intro enqueue error", error);
    });
  }

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.messagingChannelMember.findUnique({
    where: { channelId_address: { channelId: channel.id, address: event.from } },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.messagingIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  const fromLabel = senderIdentity
    ? await ownerFirstName(deps.prisma, senderIdentity.userId, event.from)
    : event.from;

  const approved = await deps.prisma.messagingChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "channel_message",
    provider: event.provider,
    channelId: channel.id,
    fromAddress: event.from,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const prompt = `[Group "${channel.name ?? "group"}", ${fromLabel}]: ${event.content}`;
  for (const member of approved) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (!identity) continue;
    const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
    if (!thread) continue;
    const sent = await deps.events.sendUserMessage({
      spaceId: identity.spaceId,
      threadId: thread.id,
      botId: identity.botId,
      userId: identity.userId,
      blocks: [block],
      prompt,
      trigger: "messaging",
      clientNonce: `messaging:${event.provider}:${event.handle}`,
    });
    if (sent.runId) {
      await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
        getLogger().error("messaging channel fan-out enqueue error", error);
      });
    }
  }
}

async function inviteMember(
  deps: MessagingInboundDeps,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<void> {
  const name = channel.name ?? "a group chat";
  // A returning member restarts the approval cycle; clear the prior invite
  // row or skipDuplicates would leave them with no prompt to answer.
  await deps.prisma.messagingOutbound.deleteMany({
    where: { idempotencyKey: `invite:${channel.id}:${identity.id}` },
  });
  await deps.prisma.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey: `invite:${channel.id}:${identity.id}`,
        kind: "dm",
        identityId: identity.id,
        body: `"${name}" was linked to your Rakazo agent. Reply YES to let your agent join the conversation there, or NO to stay out.`,
      },
    ],
    skipDuplicates: true,
  });
  const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
  if (thread) {
    const note = await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: `You were added to the group chat "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging invite enqueue error", error);
  });
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = user?.name.trim().split(/\s+/)[0];
  return first ? sanitizeMessagingLabel(first) : fallback;
}
