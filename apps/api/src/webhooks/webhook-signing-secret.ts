import { ORPCError } from "@orpc/server";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { WebhookSignature } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { WEBHOOK_SIGNING_SECRET_KIND } from "./webhook-inbound.js";
import { webhookSigningKey } from "./webhook-signature.js";

/**
 * Saves the secret a webhook sender generated for the bot, with how it signs, or clears it with
 * `null`. The secret the bot held before is deleted in the same transaction; its id is read under
 * the bot's row lock, so a concurrent save or clear never leaves one behind.
 */
export async function saveWebhookSigningSecret(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "put"> },
  bot: { id: string; spaceId: string; userId: string },
  input: { signature: WebhookSignature; secret: string; context: AdapterContext } | null,
): Promise<void> {
  if (input && !webhookSigningKey(input.signature.scheme, input.secret)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This signing secret doesn't match the chosen signature format",
    });
  }
  const stored = input ? await deps.secretStore.put(input.secret, input.context) : null;
  await deps.prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ webhookSigningSecretId: string | null }>>`
      SELECT "webhookSigningSecretId" FROM "bots" WHERE id = ${bot.id} FOR UPDATE`;
    if (!locked) throw new ORPCError("NOT_FOUND");
    const owner = { userId: bot.userId, spaceId: bot.spaceId, kind: WEBHOOK_SIGNING_SECRET_KIND };
    if (stored) {
      await tx.secret.create({ data: { ...owner, id: stored.id, ciphertext: stored.ciphertext } });
    }
    await tx.bot.update({
      where: { id: bot.id },
      data: {
        webhookSigningSecretId: stored?.id ?? null,
        webhookSignature: input ? input.signature : Prisma.DbNull,
      },
    });
    if (locked.webhookSigningSecretId) {
      await tx.secret.deleteMany({ where: { ...owner, id: locked.webhookSigningSecretId } });
    }
  });
}
