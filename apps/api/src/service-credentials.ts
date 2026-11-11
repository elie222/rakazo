import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor, ServiceCredential, ServiceScope } from "@rakazo/contracts";
import { SERVICE_CREDENTIALS_PER_MEMBER, ServiceScopeSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { recordAuditEvent, runAsSystem } from "@rakazo/db";

const TOKEN_PREFIX = "rks_";
const TOKEN_PATTERN = /^rks_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Requests one key may make per minute, counted in Postgres so every instance shares the budget. */
export const SERVICE_REQUESTS_PER_MINUTE = 120;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type CredentialRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  botIds: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function credentialDto(row: CredentialRow): ServiceCredential {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes.flatMap((scope) => {
      const parsed = ServiceScopeSchema.safeParse(scope);
      return parsed.success ? [parsed.data] : [];
    }),
    botIds: row.botIds,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listServiceCredentials(
  prisma: PrismaClient,
  actor: Actor,
): Promise<ServiceCredential[]> {
  const rows = await prisma.serviceCredential.findMany({
    where: { userId: actor.userId, spaceId: actor.spaceId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return rows.map(credentialDto);
}

export async function createServiceCredential(
  prisma: PrismaClient,
  actor: Actor,
  input: { name: string; scopes: ServiceScope[]; botIds: string[]; expiresInDays: number },
): Promise<{ credential: ServiceCredential; token: string }> {
  const botIds = [...new Set(input.botIds)];
  if (botIds.length) {
    const owned = await prisma.bot.count({
      where: { id: { in: botIds }, spaceId: actor.spaceId, archivedAt: null },
    });
    if (owned !== botIds.length) throw new ORPCError("NOT_FOUND", { message: "Bot not found" });
  }
  const now = new Date();
  const active = await prisma.serviceCredential.count({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (active >= SERVICE_CREDENTIALS_PER_MEMBER) {
    throw new ORPCError("BAD_REQUEST", { message: "Revoke a key before creating another" });
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = await prisma.serviceCredential.create({
    data: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      name: input.name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
      scopes: [...new Set(input.scopes)],
      botIds,
      expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
    },
  });
  await recordAuditEvent({
    action: "service_credential.created",
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    target: { type: "service_credential", id: row.id, label: row.name },
    metadata: { botCount: botIds.length, expiresInDays: input.expiresInDays },
  });
  return { credential: credentialDto(row), token };
}

export async function revokeServiceCredential(
  prisma: PrismaClient,
  actor: Actor,
  id: string,
): Promise<void> {
  const row = await prisma.serviceCredential.findFirst({
    where: { id, userId: actor.userId, spaceId: actor.spaceId },
    select: { id: true, name: true, revokedAt: true },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Key not found" });
  if (row.revokedAt) return;
  await prisma.serviceCredential.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAuditEvent({
    action: "service_credential.revoked",
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    target: { type: "service_credential", id: row.id, label: row.name },
  });
}

export type AuthenticatedServiceCredential = {
  id: string;
  name: string;
  userId: string;
  spaceId: string;
  scopes: string[];
  botIds: string[];
  expiresAt: string;
  /** Whether this request is inside the key's per-minute budget. */
  withinLimit: boolean;
  remaining: number;
  /** Seconds until the per-minute budget refills. */
  resetSeconds: number;
};

/** Null for a token that is malformed, unknown, revoked or expired, without saying which. */
export async function authenticateServiceCredential(
  prisma: PrismaClient,
  token: string,
): Promise<AuthenticatedServiceCredential | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenHash = hashToken(token);
  return runAsSystem("authenticate a service credential", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        userId: string;
        spaceId: string;
        scopes: string[];
        botIds: string[];
        expiresAt: Date;
        windowCount: number;
        resetSeconds: number;
      }>
    >`UPDATE "service_credentials" SET
        "lastUsedAt" = now(),
        "windowCount" = CASE WHEN "windowStartedAt" <= now() - interval '1 minute'
          THEN 1 ELSE "windowCount" + 1 END,
        "windowStartedAt" = CASE WHEN "windowStartedAt" <= now() - interval '1 minute'
          THEN now() ELSE "windowStartedAt" END
      WHERE "tokenHash" = ${tokenHash} AND "revokedAt" IS NULL AND "expiresAt" > now()
        -- A deactivated account's keys stop with its sessions, even if a revoke step failed.
        AND NOT EXISTS (
          SELECT 1 FROM "user" u WHERE u."id" = "service_credentials"."userId" AND u."deactivatedAt" IS NOT NULL
        )
      RETURNING "id", "name", "userId", "spaceId", "scopes", "botIds", "expiresAt", "windowCount",
        LEAST(60, GREATEST(1, CEIL(60 - EXTRACT(EPOCH FROM now() - "windowStartedAt"))))::int AS "resetSeconds"`;
    const row = rows[0];
    if (!row) return null;
    const { windowCount, expiresAt, ...credential } = row;
    return {
      ...credential,
      expiresAt: expiresAt.toISOString(),
      withinLimit: windowCount <= SERVICE_REQUESTS_PER_MINUTE,
      remaining: Math.max(0, SERVICE_REQUESTS_PER_MINUTE - windowCount),
    };
  });
}

/** For a long-lived stream, which authenticated once and has to notice a revocation. */
export async function isServiceCredentialLive(prisma: PrismaClient, id: string): Promise<boolean> {
  return runAsSystem("check a service credential", async () => {
    const live = await prisma.serviceCredential.count({
      where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    return live === 1;
  });
}
