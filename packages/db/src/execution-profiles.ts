import { randomUUID } from "node:crypto";
import type {
  CreateExecutionProfileInput as CreateProfileInput,
  ExecutionProfileSnapshot,
  ExecutionProfile as ProfileDto,
} from "@rakazo/contracts";
import {
  CreateExecutionProfileInput,
  ExecutionProfileSchema,
  ExecutionProfileSnapshotSchema,
} from "@rakazo/contracts";
import type { ExecutionProfile, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type ProfileScope = { spaceId: string; userId: string };
type ProfileDb = Pick<
  PrismaClient,
  "executionProfile" | "userModelCredential" | "secret" | "computer" | "bot" | "spaceMember"
>;

export class ExecutionProfileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionProfileUnavailableError";
  }
}

export function executionProfileDto(profile: ExecutionProfile): ProfileDto {
  return ExecutionProfileSchema.parse({
    ...profile,
    createdAt: profile.createdAt.toISOString(),
  });
}

async function assertProfileMembership(prisma: ProfileDb, scope: ProfileScope): Promise<void> {
  const member = await prisma.spaceMember.findFirst({
    where: { spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true },
  });
  if (!member) throw new IsolationError();
}

async function exactCredential(
  prisma: ProfileDb,
  scope: ProfileScope,
  input: { credentialId: string; provider: string },
) {
  const credential = await prisma.userModelCredential.findFirst({
    where: { id: input.credentialId, userId: scope.userId, provider: input.provider },
  });
  if (!credential) {
    throw new ExecutionProfileUnavailableError("The execution profile account is disconnected.");
  }
  const secret = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true },
  });
  if (!secret) {
    throw new ExecutionProfileUnavailableError("The execution profile account is unavailable.");
  }
  return credential;
}

async function assertProfileComputer(
  prisma: ProfileDb,
  scope: ProfileScope,
  computerId: string | null,
): Promise<void> {
  if (!computerId) return;
  const computer = await prisma.computer.findFirst({
    where: { id: computerId, spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true },
  });
  if (!computer) throw new IsolationError();
}

/** Only this account is resolved. A revoked, deleted, or foreign ID never falls back. */
export async function resolveExecutionProfile(
  prisma: ProfileDb,
  scope: ProfileScope,
  profileId: string,
) {
  await assertProfileMembership(prisma, scope);
  const profile = await prisma.executionProfile.findFirst({
    where: { id: profileId, spaceId: scope.spaceId, userId: scope.userId },
  });
  if (!profile) throw new IsolationError();
  CreateExecutionProfileInput.parse(profile);
  const credential = await exactCredential(prisma, scope, profile);
  await assertProfileComputer(prisma, scope, profile.computerId);
  return { profile, credential };
}

export async function createExecutionProfile(
  prisma: PrismaClient,
  scope: ProfileScope,
  input: CreateProfileInput,
) {
  const parsed = CreateExecutionProfileInput.parse(input);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await assertProfileMembership(tx, scope);
        await exactCredential(tx, scope, parsed);
        await assertProfileComputer(tx, scope, parsed.computerId);
        const previous = parsed.supersedesId
          ? await tx.executionProfile.findFirst({
              where: { id: parsed.supersedesId, spaceId: scope.spaceId, userId: scope.userId },
            })
          : null;
        if (parsed.supersedesId && !previous) throw new IsolationError();
        const latest = previous
          ? await tx.executionProfile.findFirst({
              where: { spaceId: scope.spaceId, userId: scope.userId, seriesId: previous.seriesId },
              orderBy: { revision: "desc" },
            })
          : null;
        const { supersedesId: _supersedesId, ...configuration } = parsed;
        return tx.executionProfile.create({
          data: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            ...configuration,
            seriesId: previous?.seriesId ?? randomUUID(),
            revision: (latest?.revision ?? 0) + 1,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export function executionProfileSnapshot(
  profile: ExecutionProfile,
  credentialSecretId: string,
  botComputerId: string | null,
  credentialLabel = "Connected account",
): ExecutionProfileSnapshot {
  return ExecutionProfileSnapshotSchema.parse({
    ...profile,
    profileId: profile.id,
    profileName: profile.name,
    credentialLabel,
    credentialSecretId,
    computerId: profile.computerId ?? botComputerId,
  });
}

/** The insert trigger is authoritative; this helper is useful for enqueue previews/tests. */
export async function snapshotBotExecutionProfile(
  prisma: ProfileDb,
  input: ProfileScope & { botId: string },
): Promise<ExecutionProfileSnapshot | null> {
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, userId: input.userId },
    select: { executionProfileId: true, computerId: true },
  });
  if (!bot) throw new IsolationError();
  if (!bot.executionProfileId) return null;
  const { profile, credential } = await resolveExecutionProfile(
    prisma,
    input,
    bot.executionProfileId,
  );
  const snapshot = executionProfileSnapshot(
    profile,
    credential.secretId,
    bot.computerId,
    credential.label,
  );
  await assertProfileComputer(prisma, input, snapshot.computerId);
  return snapshot;
}

/** Recheck access and revocation at each attempt, without rereading the bot's current binding. */
export async function resolveRunExecutionProfile(
  prisma: ProfileDb,
  input: ProfileScope & { botId: string; executionProfileSnapshot?: unknown },
) {
  if (input.executionProfileSnapshot == null) return null;
  const parsed = ExecutionProfileSnapshotSchema.safeParse(input.executionProfileSnapshot);
  if (!parsed.success) {
    throw new ExecutionProfileUnavailableError("The run execution profile is invalid.");
  }
  const snapshot = parsed.data;
  if (snapshot.spaceId !== input.spaceId || snapshot.userId !== input.userId) {
    throw new IsolationError();
  }
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, userId: input.userId },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
  const { profile, credential } = await resolveExecutionProfile(prisma, input, snapshot.profileId);
  if (credential.secretId !== snapshot.credentialSecretId) {
    throw new ExecutionProfileUnavailableError(
      "The execution profile account changed after this run was queued. Start a new run.",
    );
  }
  const expected = executionProfileSnapshot(
    profile,
    credential.secretId,
    snapshot.computerId,
    snapshot.credentialLabel,
  );
  for (const key of Object.keys(expected) as Array<keyof ExecutionProfileSnapshot>) {
    if (key === "profileName" || key === "credentialLabel") continue;
    const equal =
      key === "inputModalities"
        ? JSON.stringify([...snapshot.inputModalities].sort()) ===
          JSON.stringify([...expected.inputModalities].sort())
        : key === "modelRoles"
          ? JSON.stringify(Object.entries(snapshot.modelRoles).sort()) ===
            JSON.stringify(Object.entries(expected.modelRoles).sort())
          : snapshot[key] === expected[key];
    if (!equal) {
      throw new ExecutionProfileUnavailableError(
        "The run execution profile does not match its revision.",
      );
    }
  }
  await assertProfileComputer(prisma, input, snapshot.computerId);
  return { profile, credential, snapshot };
}
