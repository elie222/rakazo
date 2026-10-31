import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withTransactionRetry } from "@rakazo/db";
import { credentialDigest } from "./credential-digest.js";
import { EncryptedSecretStore } from "./secrets.js";

export interface PushRecord {
  token: string;
  sessionId?: string;
  presentation?: "android_sender";
}

/** Account-wide registrations, shared by API replicas and notification workers. */
export interface PushTokenStore {
  load(userId: string): Promise<PushRecord | undefined>;
  save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void>;
  /** Import only when neither the account nor the device is registered already. */
  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean>;
  remove(userId: string, tokenDigest?: string): Promise<void>;
  endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void>;
}

export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
  }
}

export class PrismaPushTokenStore implements PushTokenStore {
  private readonly encryption: EncryptedSecretStore;

  constructor(
    private readonly prisma: PrismaClient,
    encryptionKey: string,
  ) {
    this.encryption = new EncryptedSecretStore(encryptionKey);
  }

  async load(userId: string): Promise<PushRecord | undefined> {
    return runAsSystem("load an account's notification registration", async () => {
      const row = await this.prisma.pushToken.findUnique({ where: { userId } });
      if (!row) return undefined;
      return {
        token: await this.encryption.load(row.ciphertext, `push-token:${userId}`),
        sessionId: row.sessionId,
        ...(row.presentation === "android_sender"
          ? { presentation: "android_sender" as const }
          : {}),
      };
    });
  }

  async save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void> {
    await this.register(userId, token, sessionId, "register", presentation);
  }

  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean> {
    return this.register(userId, token, sessionId, "import");
  }

  private async register(
    userId: string,
    token: string,
    sessionId: string,
    mode: "register" | "import",
    presentation?: "android_sender",
  ): Promise<boolean> {
    const value = token.trim();
    if (!value) throw new Error("Push token is empty");
    const tokenDigest = credentialDigest(value);
    const sealed = await this.encryption.put(
      value,
      {
        operationId: "push.register",
        traceId: "push.register",
        spaceId: "",
        userId,
        signal: new AbortController().signal,
      },
      { recordId: `push-token:${userId}` },
    );
    return runAsSystem("register or import a notification device", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Account locks serialize sign-out/replacement; token locks serialize device handover.
          // Keep advisory acquisition ordered; row-lock conflicts during handover are retried.
          for (const key of [`push-user:${userId}`, `push-token:${tokenDigest}`].sort())
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
          // Legacy files are weaker evidence than any existing database registration.
          // Use the same locks as live registration so the check and insert are atomic.
          if (
            mode === "import" &&
            (await tx.pushToken.findFirst({
              where: { OR: [{ userId }, { tokenDigest }] },
              select: { userId: true },
            }))
          )
            return false;
          // Lock the session against deletion until registration commits. A late registration
          // after sign-out cannot publish a token, even when its request authenticated earlier.
          const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "session" WHERE id = ${sessionId} AND "userId" = ${userId}
          AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
          if (!sessions.length) throw new PushSessionEndedError();
          const data = {
            ciphertext: sealed.ciphertext,
            tokenDigest,
            sessionId,
            presentation: presentation ?? null,
          };
          if (mode === "import") await tx.pushToken.create({ data: { userId, ...data } });
          else {
            await tx.pushToken.deleteMany({ where: { tokenDigest, userId: { not: userId } } });
            await tx.pushToken.upsert({
              where: { userId },
              create: { userId, ...data },
              update: data,
            });
          }
          return true;
        }),
      ),
    );
  }

  async remove(userId: string, tokenDigest?: string): Promise<void> {
    await runAsSystem("remove an account's notification registration", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          await tx.pushToken.deleteMany({
            where: { userId, ...(tokenDigest ? { tokenDigest } : {}) },
          });
        }),
      ),
    );
  }

  async endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void> {
    await runAsSystem("revoke or retarget a session's notification registration", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          const where = { userId, sessionId };
          if (nextSessionId) {
            const session = await tx.session.findFirst({
              where: { id: nextSessionId, userId, expiresAt: { gt: new Date() } },
              select: { id: true },
            });
            if (!session) {
              await tx.pushToken.deleteMany({ where });
              return;
            }
            await tx.pushToken.updateMany({ where, data: { sessionId: nextSessionId } });
          } else await tx.pushToken.deleteMany({ where });
        }),
      ),
    );
  }
}
