import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type CredentialSecretClient = Pick<
  PrismaClient,
  "secret" | "userModelCredential" | "userVoiceCredential"
>;

export async function deleteUnreferencedCredentialSecret(
  prisma: CredentialSecretClient,
  input: {
    credentialKind: "model" | "voice";
    credentialId: string;
    secretId: string;
  },
): Promise<void> {
  const [modelReferences, voiceReferences] = await Promise.all([
    prisma.userModelCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "model" ? { id: { not: input.credentialId } } : {}),
      },
    }),
    prisma.userVoiceCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "voice" ? { id: { not: input.credentialId } } : {}),
      },
    }),
  ]);
  if (modelReferences + voiceReferences === 0) {
    await prisma.secret.deleteMany({ where: { id: input.secretId } });
  }
}

/**
 * Drop a model credential whose stored OAuth material is dead, along with the
 * secret row nothing else references.
 *
 * Two guards keep a stale failure from deleting newer material:
 * - `secretId`: a reconnect swaps the credential to a fresh secret row, so a
 *   mismatch means the retired material is already gone.
 * - `matchesFailedSecret`: a concurrent successful refresh rewrites the same
 *   secret row in place. The serializable delete rechecks its pointer and
 *   ciphertext and skips on mismatch; a secret row that is already gone has
 *   nothing newer to protect, so the credential is still deleted.
 */
export async function retireModelCredential(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    userId: string;
    credentialId: string;
    secretId?: string;
    matchesFailedSecret?: (secret: {
      id: string;
      ciphertext: string;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  if (!input.credentialId) return false;
  return withTransactionRetry(async () => {
    const checked = input.matchesFailedSecret
      ? await prisma.$transaction(async (tx) => {
          const credential = await tx.userModelCredential.findFirst({
            where: { id: input.credentialId, userId: input.userId },
          });
          if (!credential || (input.secretId && credential.secretId !== input.secretId))
            return undefined;
          return {
            credential,
            secret: await tx.secret.findFirst({
              where: { id: credential.secretId },
              select: { id: true, ciphertext: true },
            }),
          };
        })
      : undefined;
    if (
      input.matchesFailedSecret &&
      (!checked || (checked.secret && !(await input.matchesFailedSecret(checked.secret))))
    )
      return false;
    return prisma.$transaction(
      async (tx) => {
        const credential = await tx.userModelCredential.findFirst({
          where: { id: input.credentialId, userId: input.userId },
        });
        if (!credential || (input.secretId && credential.secretId !== input.secretId)) return false;
        if (input.matchesFailedSecret) {
          const secret = await tx.secret.findFirst({
            where: { id: credential.secretId },
            select: { id: true, ciphertext: true },
          });
          if (
            credential.secretId !== checked?.credential.secretId ||
            secret?.ciphertext !== checked?.secret?.ciphertext
          )
            return false;
        }
        // Its own model and the role rows pinned to it go with it.
        await tx.userModelCredential.delete({ where: { id: credential.id } });
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: credential.id,
          secretId: credential.secretId,
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
}
