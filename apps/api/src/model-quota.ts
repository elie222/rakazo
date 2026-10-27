import { ORPCError } from "@orpc/server";
import type { ModelQuotaReader } from "@rakazo/adapters";
import { oauthCredentialAccountId, parseModelSecret } from "@rakazo/adapters";
import type { RouterContext } from "./routes/context.js";

/** Resolve the exact owned connection; never borrow a provider's default key. */
export async function readConnectionQuota(
  ctx: RouterContext,
  reader: ModelQuotaReader,
  actor: { userId: string; spaceId: string },
  credentialId: string,
  options: { fresh?: boolean } = {},
) {
  const row = await ctx.deps.prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId: actor.userId },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  const secret = await ctx.deps.prisma.secret.findFirst({
    where: { id: row.secretId, userId: actor.userId, spaceId: null },
  });
  let accessToken: string | null = null;
  let accountId: string | undefined;
  let baseUrl: string | undefined;
  if (secret) {
    try {
      const stored = parseModelSecret(await ctx.deps.secrets.load(secret.ciphertext, secret.id));
      if (row.provider === "opencode-go" && stored.kind === "api_key") {
        accessToken = stored.key;
      } else if (row.provider === "openai-compatible" && stored.kind === "openai_compatible") {
        baseUrl = stored.baseUrl;
        accessToken = stored.apiKey ?? null;
      } else if (stored.kind === "oauth") {
        if (stored.credential.expires > Date.now() + 30_000) {
          accessToken = stored.credential.access;
          accountId = oauthCredentialAccountId(stored.credential);
        } else {
          ctx.refreshExpiredCredential(actor, row.secretId, row.provider);
        }
      }
    } catch {
      // No credential or decryption diagnostics leave the server.
    }
  }
  return reader.read(
    {
      userId: actor.userId,
      credentialId,
      provider: row.provider,
      revision: secret?.ciphertext ?? row.secretId,
      accessToken,
      accountId,
      baseUrl,
    },
    { fresh: options.fresh ?? false },
  );
}
