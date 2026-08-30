import { randomBytes } from "node:crypto";
import { bootstrapUserWorkspace, type SignupPolicyEnv } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

export interface ProvisionedPhoneIdentity {
  phoneE164: string;
  userId: string;
  workspaceId: string;
  botId: string;
  threadId: string;
  created: boolean;
}

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

function phoneEmail(phoneE164: string): string {
  return `phone-${phoneE164.replace(/[^0-9]/g, "")}@phone.invalid`;
}

/**
 * One phone number = one user + workspace + one bot ("their agent").
 * The synthetic `phone-…@phone.invalid` user has no Account row, so it
 * cannot log in until account linking lands; text is its only surface.
 *
 * Every step is resumable: a crash (or a lost race) at any point leaves
 * state the next inbound from the same number completes instead of
 * wedging on a unique constraint.
 */
export async function provisionPhoneIdentity(
  prisma: PrismaClient,
  phoneE164: string,
  env: SignupPolicyEnv,
): Promise<ProvisionedPhoneIdentity> {
  if (!E164_PATTERN.test(phoneE164)) {
    throw new Error(`Invalid E.164 phone number: ${phoneE164}`);
  }

  const existing = await prisma.phoneIdentity.findUnique({ where: { phoneE164 } });
  if (existing) {
    const thread = await prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`phone identity ${existing.id} has no thread`);
    return {
      phoneE164,
      userId: existing.userId,
      workspaceId: existing.workspaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  }

  const email = phoneEmail(phoneE164);
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user
      .create({
        data: {
          id: randomBytes(16).toString("hex"),
          name: `Phone ${phoneE164.slice(-4)}`,
          email,
          emailVerified: false,
        },
      })
      // A concurrent first-inbound from the same number won the email race.
      .catch(() => prisma.user.findUniqueOrThrow({ where: { email } }));
  }

  const member = await prisma.member.findFirst({ where: { userId: user.id } });
  const workspaceId =
    member?.organizationId ??
    (
      await bootstrapUserWorkspace(prisma, user, env, {
        claimDeploymentOwner: false,
      })
    ).workspaceId;

  // A previous attempt may have died between createBot and the identity row;
  // phone users only ever get bots here, so an existing bot is the phone bot.
  let botId = (
    await prisma.bot.findFirst({
      where: { workspaceId, userId: user.id, archivedAt: null },
      select: { id: true },
    })
  )?.id;
  if (!botId) {
    const repos = createRepos(prisma);
    const bot = await repos.createBot(
      {
        userId: user.id,
        workspaceId,
        email: user.email,
        isDeploymentOwner: false,
      },
      {
        name: "Assistant",
        title: "",
        description: `Personal agent for ${phoneE164}, auto-created on first text.`,
        instructions:
          "You are the owner's personal agent. The owner reaches you by iMessage text; " +
          "keep replies concise and conversational. Your first reply doubles as onboarding: " +
          "briefly introduce yourself and what you can help with.",
        notifyOnFinish: true,
      },
    );
    botId = bot.id;
  }

  const thread = await prisma.thread.findFirst({ where: { botId } });
  if (!thread) throw new Error(`bot ${botId} has no thread after createBot`);

  try {
    await prisma.phoneIdentity.create({
      data: { phoneE164, userId: user.id, workspaceId, botId },
    });
  } catch {
    // A concurrent first-inbound won the phoneE164 race; report its result.
    const winner = await prisma.phoneIdentity.findUnique({ where: { phoneE164 } });
    if (!winner) throw new Error(`phone identity for ${phoneE164} vanished after create failed`);
    // The winner's bot can differ from the bot this attempt found or
    // created; pair the result with the winning bot's own thread.
    const winnerThread =
      winner.botId === botId
        ? thread
        : await prisma.thread.findFirst({ where: { botId: winner.botId } });
    if (!winnerThread) throw new Error(`bot ${winner.botId} has no thread`);
    return {
      phoneE164,
      userId: winner.userId,
      workspaceId: winner.workspaceId,
      botId: winner.botId,
      threadId: winnerThread.id,
      created: false,
    };
  }
  return { phoneE164, userId: user.id, workspaceId, botId, threadId: thread.id, created: true };
}
