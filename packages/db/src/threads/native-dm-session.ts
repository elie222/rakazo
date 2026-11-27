import { createHash } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { PrismaClient } from "../database/client.js";
import { runAsSystem } from "../database/row-security.js";
import { ciphertextKeyId, decryptText, encryptText } from "../encryption/content-crypto.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";
import type { Prisma } from "../generated/prisma/client.js";
import { readMessageBlocks } from "./message-blocks.js";

const MAX_PAYLOAD = 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const identities = {
  name: true,
  description: true,
  instructions: true,
} as const;

type Profile = { name: string; description: string; instructions: string };

export function nativeDmProfileRevision(profile: Profile): string {
  return createHash("sha256")
    .update(JSON.stringify([profile.name, profile.description, profile.instructions]))
    .digest("hex");
}

type TurnFence = {
  runId: string;
  threadId: string;
  spaceId: string;
  botId: string;
  leaseOwner: string;
  leaseFence: number;
};

type Binding = {
  threadId: string;
  spaceId: string;
  userId: string;
  botId: string;
  sourceId: string;
  sourceSeq: number;
  generation: number;
  runtimeId: string;
  modelId: string;
  provider: string;
  credentialId: string;
  membershipId: string;
  credentialRevision: string;
  profileRevision: string;
  grant: string;
};

const snapshotSchema = z.strictObject({
  scope: z.string().regex(/^[0-9a-f]{64}$/),
  sessionId: z.string().regex(/^[0-9a-f-]{36}$/),
  transcript: z.string().max(512 * 1024),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type NativeDmSnapshot = z.infer<typeof snapshotSchema>;
export type NativeDmCommit = { binding: Binding; ciphertext: string };

type Db = Prisma.TransactionClient;

async function readBinding(
  db: Db,
  turn: TurnFence,
  grant: string,
  completed: boolean,
): Promise<Binding | undefined> {
  const run = await db.run.findFirst({
    where: {
      id: turn.runId,
      threadId: turn.threadId,
      spaceId: turn.spaceId,
      botId: turn.botId,
      nativeDmResumeGrant: grant,
      modelPinned: true,
      trigger: "user",
      routineId: null,
      ...(completed
        ? { status: "completed" }
        : { status: "running", leaseOwner: turn.leaseOwner, leaseFence: turn.leaseFence }),
      space: { deletingAt: null },
      thread: { botId: turn.botId, groupId: null, externalConversationId: null, helperBotId: null },
      bot: { archivedAt: null, spaceId: turn.spaceId },
    },
    select: {
      userId: true,
      primaryRuntime: true,
      modelId: true,
      modelProvider: true,
      modelCredentialId: true,
      bot: {
        select: {
          ...identities,
          userId: true,
          modelId: true,
          modelProvider: true,
          modelCredentialId: true,
        },
      },
      thread: { select: { userId: true, spaceId: true, historyCompactionGeneration: true } },
      sourceMessage: {
        select: {
          id: true,
          seq: true,
          threadId: true,
          role: true,
          authorUserId: true,
          runId: true,
          replyToMessageId: true,
          blocks: true,
        },
      },
    },
  });
  if (
    !run?.primaryRuntime ||
    !run.modelId ||
    !run.modelProvider ||
    !run.modelCredentialId ||
    run.userId !== run.bot.userId ||
    run.userId !== run.thread.userId ||
    run.thread.spaceId !== turn.spaceId ||
    run.bot.modelId !== run.modelId ||
    run.bot.modelProvider !== run.modelProvider ||
    run.bot.modelCredentialId !== run.modelCredentialId
  )
    return;
  const source = run.sourceMessage;
  if (
    source?.threadId !== turn.threadId ||
    source.role !== "user" ||
    source.runId !== turn.runId ||
    source.replyToMessageId !== null ||
    source.authorUserId !== run.userId
  )
    return;
  const { blocks, intact } = readMessageBlocks(source);
  if (!intact || blocks.length !== 1 || blocks[0]?.kind !== "text" || !blocks[0].text.trim())
    return;
  const member = await db.spaceMember.findFirst({
    where: { spaceId: turn.spaceId, userId: run.userId, member: { user: { deactivatedAt: null } } },
    select: { id: true },
  });
  if (!member) return;
  const credential = await db.userModelCredential.findFirst({
    where: { id: run.modelCredentialId, userId: run.userId, provider: run.modelProvider },
    select: { secretId: true, updatedAt: true },
  });
  if (!credential) return;
  return {
    threadId: turn.threadId,
    spaceId: turn.spaceId,
    userId: run.userId,
    botId: turn.botId,
    sourceId: source.id,
    sourceSeq: source.seq,
    generation: run.thread.historyCompactionGeneration,
    runtimeId: run.primaryRuntime,
    modelId: run.modelId,
    provider: run.modelProvider,
    credentialId: run.modelCredentialId,
    membershipId: member.id,
    credentialRevision: createHash("sha256")
      .update(JSON.stringify([credential.secretId, credential.updatedAt.toISOString()]))
      .digest("hex"),
    profileRevision: nativeDmProfileRevision(run.bot),
    grant,
  };
}

function scope(b: Binding) {
  return JSON.stringify([
    b.spaceId,
    b.userId,
    b.botId,
    b.threadId,
    b.generation,
    b.runtimeId,
    b.modelId,
    b.provider,
    b.credentialId,
    b.membershipId,
    b.credentialRevision,
    b.profileRevision,
    b.grant,
  ]);
}

const location = (threadId: string, userId: string, sourceId: string) => ({
  table: "native_dm_sessions",
  column: "ciphertext",
  rowId: JSON.stringify([threadId, sourceId]),
  owner: userId,
});

/** Read only the immediately preceding completed native turn. Never graft across a gap. */
export async function prepareNativeDmSession(
  prisma: PrismaClient,
  turn: TurnFence,
  grant: string,
  profileRevision: string,
) {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring?.encryptWrites) return;
  let key: Awaited<ReturnType<typeof ring.current>>;
  try {
    key = await ring.current(turn.spaceId);
    if (key.spaceId !== turn.spaceId) return;
  } catch {
    getLogger().warn("native_dm_session.key_unavailable");
    return;
  }
  const staged = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${turn.threadId} FOR UPDATE`;
    const binding = await readBinding(tx, turn, grant, false);
    if (!binding || binding.profileRevision !== profileRevision) return;
    await tx.nativeDmSession.deleteMany({
      where: { threadId: turn.threadId, expiresAt: { lte: new Date() } },
    });
    const previous = await tx.nativeDmSession.findFirst({
      where: {
        threadId: turn.threadId,
        spaceId: turn.spaceId,
        userId: binding.userId,
        expiresAt: { gt: new Date() },
        reply: {
          threadId: turn.threadId,
          seq: binding.sourceSeq - 1,
          botId: turn.botId,
          role: "bot",
        },
      },
      select: { ciphertext: true, sourceId: true },
    });
    return { binding, previous };
  });
  if (!staged) return;
  const { binding, previous } = staged;
  let snapshot: NativeDmSnapshot | undefined;
  try {
    const keyId = previous && ciphertextKeyId(previous.ciphertext);
    if (previous && keyId) {
      const oldKey = await ring.byId(keyId);
      if (oldKey.spaceId === binding.spaceId) {
        const parsed: unknown = JSON.parse(
          decryptText(
            oldKey,
            location(binding.threadId, binding.userId, previous.sourceId),
            previous.ciphertext,
          ),
        );
        const payload = z
          .strictObject({ scope: z.string(), snapshot: snapshotSchema })
          .safeParse(parsed);
        if (payload.success && payload.data.scope === scope(binding))
          snapshot = payload.data.snapshot;
      }
    }
  } catch {
    // Neither a missing key nor an unreadable envelope may fall back to plaintext.
    getLogger().warn("native_dm_session.key_or_snapshot_unavailable");
    return;
  }
  return {
    binding,
    previous: snapshot,
    seal(candidate: NativeDmSnapshot): NativeDmCommit | undefined {
      if (!snapshotSchema.safeParse(candidate).success) return;
      const payload = JSON.stringify({ scope: scope(binding), snapshot: candidate });
      if (Buffer.byteLength(payload) > MAX_PAYLOAD) return;
      return {
        binding,
        ciphertext: encryptText(
          key,
          location(binding.threadId, binding.userId, binding.sourceId),
          payload,
        ),
      };
    },
  };
}

/** Only called inside the successful terminal transaction, after run and attempt fencing. */
export async function commitNativeDmSession(
  tx: Db,
  turn: TurnFence,
  commit: NativeDmCommit,
  replySeq: number,
  replyId: string,
  now: Date,
): Promise<void> {
  const binding = await readBinding(tx, turn, commit.binding.grant, true);
  if (
    !binding ||
    scope(binding) !== scope(commit.binding) ||
    binding.sourceId !== commit.binding.sourceId ||
    replySeq !== binding.sourceSeq + 1 ||
    !ciphertextKeyId(commit.ciphertext)
  )
    return;
  const row = {
    sourceId: binding.sourceId,
    replyId,
    spaceId: binding.spaceId,
    userId: binding.userId,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
    ciphertext: commit.ciphertext,
  };
  await tx.nativeDmSession.upsert({
    where: { threadId: binding.threadId },
    create: { threadId: binding.threadId, ...row },
    update: row,
  });
}

/** Reconcile expiry independently of general chat retention, even with pilot grants removed. */
export async function pruneNativeDmSessions(prisma: PrismaClient, now: Date): Promise<number> {
  const removed = await runAsSystem("prune expired native DM sessions", () =>
    prisma.nativeDmSession.deleteMany({ where: { expiresAt: { lte: now } } }),
  );
  return removed.count;
}
