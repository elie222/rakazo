import type { JobPublisher, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { phoneDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { parsePhoneCommand, sanitizePhoneLabel } from "@rakazo/core";
import type {
  Prisma,
  PrismaClient,
  ProvisionedPhoneIdentity,
  SignupPolicyEnv,
  ThreadEvents,
} from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";

export interface PhoneInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  provision: (phoneE164: string, env: SignupPolicyEnv) => Promise<ProvisionedPhoneIdentity>;
  signupPolicy: SignupPolicyEnv;
  /** The deployment's own line, so it is never treated as a participant. */
  lineNumber: string;
  /**
   * Best-effort "…" bubbles shown to a 1:1 texter while their run executes.
   * Cosmetic only — callers must catch failures; groups never get it.
   */
  typing?: (toNumber: string) => Promise<void>;
}

type PhoneIdentityRow = {
  id: string;
  phoneE164: string;
  userId: string;
  workspaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 texts are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE owner commands).
 * Group texts drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createPhoneInboundHandler(deps: PhoneInboundDeps) {
  return async (event: MessagingInboundMessage): Promise<void> => {
    if (event.groupId) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, event);
  };
}

async function handleDirectEvent(
  deps: PhoneInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  // Inbound media arrives as a CDN URL (expires after 30 days); no
  // artifact ingestion in v1, so it rides along as text.
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");

  const existing = await deps.prisma.phoneIdentity.findUnique({
    where: { phoneE164: event.fromNumber },
  });
  if (existing) {
    // Any reply — even a content-free tapback — ends the consecutive-
    // outbound streak, but only real text wakes the bot.
    await deps.prisma.phoneIdentity.update({
      where: { id: existing.id },
      data: { outboundSinceInbound: 0, lastInboundAt: new Date() },
    });
    if (!text) return;
    // Owner commands are only parsed in the verified 1:1 conversation.
    const command = parsePhoneCommand(event.content);
    if (command && (await applyPhoneCommand(deps, existing, command))) return;
  } else if (!text) {
    // Never provision a full account for a tapback or empty payload.
    return;
  }

  let ids: ProvisionedPhoneIdentity;
  if (existing) {
    const thread = await deps.prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`phone identity ${existing.id} has no thread`);
    ids = {
      phoneE164: existing.phoneE164,
      userId: existing.userId,
      workspaceId: existing.workspaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    ids = await deps.provision(event.fromNumber, deps.signupPolicy);
  }

  const sent = await deps.events.sendUserMessage({
    workspaceId: ids.workspaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "phone",
    clientNonce: `phone:${event.handle}`,
  });
  if (sent.runId) {
    // Typing bubbles only make sense once a reply is actually coming. Fire
    // before the enqueue so they land ahead of a fast reply, and never await:
    // a stalled vendor typing call must not hold the webhook open. The bubbles
    // clear on their own after a short display window or when the reply
    // arrives, so long runs simply outlive them.
    void deps.typing?.(event.fromNumber).catch((error) => {
      console.error("phone typing indicator error", error);
    });
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      console.error("phone inbound run enqueue error", error);
    });
  }
}

/** Returns true when the command matched a pending item and was handled. */
async function applyPhoneCommand(
  deps: PhoneInboundDeps,
  identity: PhoneIdentityRow,
  command: "approve" | "decline" | "leave",
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.phoneChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    const { count } = await deps.prisma.phoneChannelMember.updateMany({
      where: { id: membership.id, status: "approved" },
      data: { status: "left" },
    });
    // State changed under us (e.g. swept out and re-invited): treat the
    // text as a normal message rather than overwriting the newer state.
    if (count === 0) return false;
    await enqueueConfirmation(
      deps,
      identity.phoneE164,
      `command:leave:${membership.id}`,
      "You've left the channel; your agent will no longer post there. The iMessage group itself is unchanged. This deployment cannot remove the line from the group, so leaving only stops your agent's participation.",
    );
    return true;
  }

  const membership = await deps.prisma.phoneChannelMember.findFirst({
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
      const { count } = await tx.phoneChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) return false;
      await writeConfirmation(
        tx,
        identity.phoneE164,
        key,
        approved
          ? "You're in — your agent will now see and reply to that group."
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
    ? await deps.prisma.phoneIdentity.findUnique({
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
      identity.phoneE164,
      key,
      approved
        ? "Connection approved — your agents can now message each other."
        : "Connection declined.",
    );
    if (requesterIdentity) {
      await writeConfirmation(
        tx,
        requesterIdentity.phoneE164,
        connectedKey,
        "Your connection request was accepted — your agents can now message each other.",
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
  tx: Pick<Prisma.TransactionClient, "phoneOutbound">,
  toNumber: string,
  key: string,
  body: string,
): Promise<void> {
  await tx.phoneOutbound.deleteMany({ where: { idempotencyKey: key } });
  await tx.phoneOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", toNumber, body }],
    skipDuplicates: true,
  });
}

async function enqueueDeliverJob(deps: PhoneInboundDeps): Promise<void> {
  await deps.jobs.enqueue(phoneDeliverJob()).catch((error) => {
    console.error("phone confirmation enqueue error", error);
  });
}

async function enqueueConfirmation(
  deps: PhoneInboundDeps,
  toNumber: string,
  key: string,
  body: string,
): Promise<void> {
  // Keys are stable per membership/connection across approval cycles; clear
  // the prior cycle's row or skipDuplicates would swallow the new text.
  await deps.prisma.phoneOutbound.deleteMany({ where: { idempotencyKey: key } });
  await deps.prisma.phoneOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", toNumber, body }],
    skipDuplicates: true,
  });
  await deps.jobs.enqueue(phoneDeliverJob()).catch((error) => {
    console.error("phone confirmation enqueue error", error);
  });
}

async function handleChannelEvent(
  deps: PhoneInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const groupName = event.groupName ? sanitizePhoneLabel(event.groupName) : null;
  const channel = await deps.prisma.phoneChannel.upsert({
    where: { providerGroupId: event.groupId! },
    create: { providerGroupId: event.groupId!, name: groupName },
    update: groupName ? { name: groupName } : {},
  });

  const participants = event.participants.filter((phone) => phone !== deps.lineNumber);
  if (!participants.includes(event.fromNumber)) participants.push(event.fromNumber);

  let hasUnlinked = false;
  for (const phone of participants) {
    const identity = await deps.prisma.phoneIdentity.findUnique({
      where: { phoneE164: phone },
    });
    const member = await deps.prisma.phoneChannelMember.findUnique({
      where: { channelId_phoneE164: { channelId: channel.id, phoneE164: phone } },
    });
    if (member) {
      if (identity && !member.identityId) {
        await deps.prisma.phoneChannelMember.update({
          where: { id: member.id },
          data: { identityId: identity.id },
        });
        if (member.status === "invited") await inviteMember(deps, channel, identity);
      }
      if (member.status === "left") {
        // Back in the group: restart the approval cycle.
        await deps.prisma.phoneChannelMember.update({
          where: { id: member.id },
          data: { status: "invited" },
        });
        if (identity) await inviteMember(deps, channel, identity);
      }
      if (!identity) hasUnlinked = true;
      continue;
    }
    // Upsert, not create: concurrent group webhooks race on the unique key.
    await deps.prisma.phoneChannelMember.upsert({
      where: { channelId_phoneE164: { channelId: channel.id, phoneE164: phone } },
      create: {
        channelId: channel.id,
        phoneE164: phone,
        identityId: identity?.id ?? null,
        status: "invited",
      },
      update: {},
    });
    if (identity) await inviteMember(deps, channel, identity);
    else hasUnlinked = true;
  }

  // Someone removed from the iMessage group must stop receiving its content.
  // A webhook without a participants array says nothing about membership —
  // never sweep on partial data.
  if (event.participants.length > 0) {
    await deps.prisma.phoneChannelMember.updateMany({
      where: {
        channelId: channel.id,
        phoneE164: { notIn: participants },
        status: { in: ["invited", "approved"] },
      },
      data: { status: "left" },
    });
  }

  if (hasUnlinked && !channel.introPostedAt) {
    await deps.prisma.phoneOutbound.createMany({
      data: [
        {
          idempotencyKey: `intro:${channel.id}`,
          kind: "intro",
          providerGroupId: channel.providerGroupId,
          body: "Hi — this number hosts Rakazo personal agents. Some people in this group haven't texted this line yet; send any message to this number first if you want your own agent here.",
        },
      ],
      skipDuplicates: true,
    });
    await deps.prisma.phoneChannel.update({
      where: { id: channel.id },
      data: { introPostedAt: new Date() },
    });
    await deps.jobs.enqueue(phoneDeliverJob()).catch((error) => {
      console.error("phone intro enqueue error", error);
    });
  }

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.phoneChannelMember.findUnique({
    where: {
      channelId_phoneE164: { channelId: channel.id, phoneE164: event.fromNumber },
    },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.phoneIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  const fromLabel = senderIdentity
    ? await ownerFirstName(deps.prisma, senderIdentity.userId, event.fromNumber)
    : event.fromNumber;

  const approved = await deps.prisma.phoneChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "phone_channel_message",
    channelId: channel.id,
    fromNumber: event.fromNumber,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const prompt = `[iMessage group "${channel.name ?? "group"}" — ${fromLabel}]: ${event.content}`;
  for (const member of approved) {
    const identity = await deps.prisma.phoneIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (!identity) continue;
    const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
    if (!thread) continue;
    const sent = await deps.events.sendUserMessage({
      workspaceId: identity.workspaceId,
      threadId: thread.id,
      botId: identity.botId,
      userId: identity.userId,
      blocks: [block],
      prompt,
      trigger: "phone",
      clientNonce: `phone:${event.handle}`,
    });
    if (sent.runId) {
      await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
        console.error("phone channel fan-out enqueue error", error);
      });
    }
  }
}

async function inviteMember(
  deps: PhoneInboundDeps,
  channel: { id: string; name: string | null },
  identity: PhoneIdentityRow,
): Promise<void> {
  const name = channel.name ?? "an iMessage group";
  // A returning member restarts the approval cycle; clear the prior invite
  // row or skipDuplicates would leave them with no prompt to answer.
  await deps.prisma.phoneOutbound.deleteMany({
    where: { idempotencyKey: `invite:${channel.id}:${identity.phoneE164}` },
  });
  await deps.prisma.phoneOutbound.createMany({
    data: [
      {
        idempotencyKey: `invite:${channel.id}:${identity.phoneE164}`,
        kind: "dm",
        toNumber: identity.phoneE164,
        body: `"${name}" was linked to your Rakazo line. Reply YES to let your agent join the conversation there, or NO to stay out.`,
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
          text: `You were added to iMessage group "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
  await deps.jobs.enqueue(phoneDeliverJob()).catch((error) => {
    console.error("phone invite enqueue error", error);
  });
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = user?.name.trim().split(/\s+/)[0];
  return first ? sanitizePhoneLabel(first) : fallback;
}
