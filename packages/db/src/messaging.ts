import { randomBytes, randomInt } from "node:crypto";
import { bootstrapUserSpace, type SignupPolicyEnv } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

export interface MessagingIdentityRequest {
  /** Messaging platform hosting the conversation (sendblue, slack, …). */
  provider: string;
  /** Sender address within the provider: E.164 number, Slack user id, …. */
  address: string;
  /** Provider thread id of the 1:1 conversation, when already known. */
  dmThreadId?: string | null;
  /** Platform display name; seeds the synthetic user's name when present. */
  displayName?: string | null;
}

export interface ProvisionedMessagingIdentity {
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  created: boolean;
}

/** Addresses come from verified platform webhooks; this guards the DB shape. */
const ADDRESS_PATTERN = /^[^\s]{1,128}$/;

function messagingEmail(provider: string, address: string): string {
  const local = `${provider}-${address}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 60);
  return `msg-${local}@messaging.invalid`;
}

/**
 * One (provider, address) = one user + Space + one bot ("their agent").
 * The synthetic `msg-…@messaging.invalid` user has no Account row, so it
 * cannot log in until account linking lands; chat is its only surface.
 *
 * Every step is resumable: a crash (or a lost race) at any point leaves
 * state the next inbound from the same address completes instead of
 * wedging on a unique constraint.
 */
export async function provisionMessagingIdentity(
  prisma: PrismaClient,
  request: MessagingIdentityRequest,
  env: SignupPolicyEnv,
): Promise<ProvisionedMessagingIdentity> {
  const { provider, address } = request;
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error(`Invalid messaging address for ${provider}: ${address}`);
  }

  const where = { provider_address: { provider, address } } as const;
  const existing = await prisma.messagingIdentity.findUnique({ where });
  if (existing) {
    const thread = await prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`messaging identity ${existing.id} has no thread`);
    return {
      provider,
      address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  }

  const email = messagingEmail(provider, address);
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user
      .create({
        data: {
          id: randomBytes(16).toString("hex"),
          name: request.displayName?.trim() || `${titleCase(provider)} ${address.slice(-4)}`,
          email,
          emailVerified: false,
        },
      })
      // A concurrent first-inbound from the same address won the email race.
      .catch(() => prisma.user.findUniqueOrThrow({ where: { email } }));
  }

  const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
  const spaceId =
    membership?.spaceId ??
    (
      await bootstrapUserSpace(prisma, user, env, {
        claimDeploymentOwner: false,
      })
    ).spaceId;

  // A previous attempt may have died between createBot and the identity row;
  // messaging users only ever get bots here, so an existing bot is theirs.
  let botId = (
    await prisma.bot.findFirst({
      where: { spaceId, userId: user.id, archivedAt: null },
      select: { id: true },
    })
  )?.id;
  if (!botId) {
    const repos = createRepos(prisma);
    const bot = await repos.createBot(
      {
        userId: user.id,
        spaceId,
        email: user.email,
        isDeploymentOwner: false,
      },
      {
        name: "Assistant",
        title: "",
        description: `Personal agent for ${address} (${provider}), auto-created on first message.`,
        instructions:
          "You are the owner's personal agent. The owner reaches you over chat; " +
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
    await prisma.messagingIdentity.create({
      data: {
        provider,
        address,
        dmThreadId: request.dmThreadId ?? null,
        userId: user.id,
        spaceId,
        botId,
      },
    });
  } catch {
    // A concurrent first-inbound won the (provider, address) race; report its
    // result.
    const winner = await prisma.messagingIdentity.findUnique({ where });
    if (!winner) {
      throw new Error(`messaging identity for ${provider}:${address} vanished after create failed`);
    }
    // The winner's bot can differ from the bot this attempt found or
    // created; pair the result with the winning bot's own thread.
    const winnerThread =
      winner.botId === botId
        ? thread
        : await prisma.thread.findFirst({ where: { botId: winner.botId } });
    if (!winnerThread) throw new Error(`bot ${winner.botId} has no thread`);
    return {
      provider,
      address,
      userId: winner.userId,
      spaceId: winner.spaceId,
      botId: winner.botId,
      threadId: winnerThread.id,
      created: false,
    };
  }
  return { provider, address, userId: user.id, spaceId, botId, threadId: thread.id, created: true };
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export const MESSAGING_LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** No ambiguous glyphs (0/O, 1/I/L, U/V) — the code is typed on a phone. */
const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const LINK_CODE_LENGTH = 8;

export function formatMessagingLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A message that is exactly one code (dashes/spaces ignored) is a link
 * attempt; anything else is an ordinary message. Returns the canonical form.
 */
export function normalizeMessagingLinkCode(text: string): string | null {
  const normalized = text.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : null;
}

/**
 * Issue the user's single active link code for one of their bots. The code
 * is high-entropy (30^8) and short-lived, so redemption is the only
 * brute-force surface and it is not realistically searchable.
 */
export async function issueMessagingLinkCode(
  prisma: PrismaClient,
  request: { userId: string; spaceId: string; botId: string },
): Promise<{ code: string; expiresAt: Date }> {
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]!;
  }
  const expiresAt = new Date(Date.now() + MESSAGING_LINK_CODE_TTL_MS);
  // One active code per user: a fresh request supersedes the previous one.
  await prisma.messagingLinkCode.deleteMany({ where: { userId: request.userId } });
  await prisma.messagingLinkCode.create({
    data: { code, ...request, expiresAt },
  });
  return { code, expiresAt };
}

export interface RedeemedMessagingLink {
  identityId: string;
  userId: string;
  spaceId: string;
  botId: string;
  /** Stable per-redemption key for the confirmation outbox row. */
  confirmationKey: string;
}

/**
 * Bind the sending address to the code's user and bot. A fresh address gets
 * a new identity; the code owner's own linked address switches bots. Codes
 * are single-use and never apply to an address someone else owns.
 */
export async function redeemMessagingLinkCode(
  prisma: PrismaClient,
  request: { code: string; provider: string; address: string; dmThreadId: string | null },
): Promise<RedeemedMessagingLink | null> {
  const row = await prisma.messagingLinkCode.findUnique({ where: { code: request.code } });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      // Single-use: the delete is the claim; a concurrent redemption loses.
      const { count } = await tx.messagingLinkCode.deleteMany({ where: { id: row.id } });
      if (count === 0) return null;
      const existing = await tx.messagingIdentity.findUnique({
        where: { provider_address: { provider: request.provider, address: request.address } },
      });
      if (existing) {
        if (existing.userId !== row.userId) return null;
        await tx.messagingIdentity.update({
          where: { id: existing.id },
          // The identity must follow the bot's space: runs resolve
          // credentials, memory, and approval rules from run.spaceId.
          data: { botId: row.botId, spaceId: row.spaceId, dmThreadId: request.dmThreadId },
        });
        return {
          identityId: existing.id,
          userId: row.userId,
          spaceId: row.spaceId,
          botId: row.botId,
          confirmationKey: `link:${row.id}`,
        };
      }
      const identity = await tx.messagingIdentity.create({
        data: {
          provider: request.provider,
          address: request.address,
          dmThreadId: request.dmThreadId,
          userId: row.userId,
          spaceId: row.spaceId,
          botId: row.botId,
        },
      });
      return {
        identityId: identity.id,
        userId: row.userId,
        spaceId: row.spaceId,
        botId: row.botId,
        confirmationKey: `link:${row.id}`,
      };
    });
  } catch (error) {
    // botId is unique (one chat app per bot) and (provider, address) can race
    // a concurrent inbound; either way the code is spent and the sender can
    // request a fresh one.
    if (isUniqueViolationError(error)) return null;
    throw error;
  }
}

function isUniqueViolationError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
