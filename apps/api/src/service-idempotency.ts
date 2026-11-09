import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

const REPLAY_MS = 24 * 60 * 60 * 1000;
/** An unfinished write holds its key this long, so a crash cannot wedge a key for a day. */
export const IDEMPOTENCY_HOLD_SECONDS = 300;

export type IdempotencyClaim =
  | { kind: "claimed" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_progress" }
  | { kind: "conflict" };

export function requestHash(method: string, pathname: string, body: string): string {
  return createHash("sha256").update(`${method} ${pathname}\n${body}`).digest("hex");
}

function holdUntil(): Date {
  return new Date(Date.now() + IDEMPOTENCY_HOLD_SECONDS * 1000);
}

/** Call under the actor's tenant scope. The unique index decides which of two retries runs. */
export async function claimIdempotencyKey(
  prisma: PrismaClient,
  actor: Actor,
  credentialId: string,
  key: string,
  hash: string,
): Promise<IdempotencyClaim> {
  await prisma.serviceIdempotencyKey.deleteMany({
    where: { credentialId, expiresAt: { lte: new Date() } },
  });
  const created = await prisma.serviceIdempotencyKey.createMany({
    data: [
      {
        userId: actor.userId,
        spaceId: actor.spaceId,
        credentialId,
        key,
        requestHash: hash,
        expiresAt: holdUntil(),
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 1) return { kind: "claimed" };
  const row = await prisma.serviceIdempotencyKey.findUnique({
    where: { credentialId_key: { credentialId, key } },
  });
  if (!row || row.responseStatus === null) return { kind: "in_progress" };
  if (row.requestHash !== hash) return { kind: "conflict" };
  return { kind: "replay", status: row.responseStatus, body: row.responseBody };
}

export async function finishIdempotencyKey(
  prisma: PrismaClient,
  credentialId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await prisma.serviceIdempotencyKey.update({
    where: { credentialId_key: { credentialId, key } },
    data: {
      responseStatus: status,
      responseBody: body as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + REPLAY_MS),
    },
  });
}

/** The write was refused and nothing happened, so the same key may be used again. */
export async function releaseIdempotencyKey(
  prisma: PrismaClient,
  credentialId: string,
  key: string,
): Promise<void> {
  await prisma.serviceIdempotencyKey.deleteMany({ where: { credentialId, key } });
}
