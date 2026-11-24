import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor, ModelCredential } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { comparePreferenceOrder, newestModelCredentialOrder } from "@rakazo/db";
import { modelCredentialDto } from "./model-connect.js";
import { modelProviderAllowed, modelProviderAllowlist } from "./model-provider-allowlist.js";
import { resolveMemberMainModel } from "./model-roles.js";
import { parseModelSecret } from "./model-secret.js";

/**
 * The member's model connections, newest first, as every model picker reads them. With
 * `showMainModel`, the connection running the member's main model shows that model, as apps
 * display it. With `runnable`, only connections a run could use are listed: an allowed provider
 * whose secret loads. A secret store outage propagates; otherwise an unreadable secret lists its
 * connection without its secret details.
 */
export async function listModelCredentials(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load"> },
  actor: Pick<Actor, "userId" | "spaceId">,
  { showMainModel = false, runnable = false }: { showMainModel?: boolean; runnable?: boolean } = {},
): Promise<ModelCredential[]> {
  const [allRows, main] = await Promise.all([
    deps.prisma.userModelCredential.findMany({
      where: { userId: actor.userId },
      include: { userPreferences: { where: { userId: actor.userId } } },
      orderBy: newestModelCredentialOrder,
    }),
    showMainModel ? resolveMemberMainModel(deps, actor) : null,
  ]);
  const allowlist = modelProviderAllowlist();
  const rows = runnable
    ? allRows.filter((row) => modelProviderAllowed(allowlist, row.provider))
    : allRows;
  const secrets = rows.length
    ? await deps.prisma.secret.findMany({
        where: {
          id: { in: rows.map((row) => row.secretId) },
          userId: actor.userId,
          spaceId: null,
        },
        select: { id: true, ciphertext: true },
      })
    : [];
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const preferenceRanks = new Map(
    rows
      .flatMap((row) => row.userPreferences)
      .sort(comparePreferenceOrder)
      .map((preference, index) => [preference.credentialId, index]),
  );
  const listed = await Promise.all(
    rows.map(async ({ userPreferences, ...row }) => {
      const preference = userPreferences[0];
      const own = {
        ...row,
        defaultModel: preference?.modelId ?? null,
        thinkingLevel: preference?.thinkingLevel ?? null,
      };
      const runsMain = main?.credential && main.credential.id === row.id;
      const dto = (plaintext?: string) => {
        const listed = modelCredentialDto(own, plaintext);
        // The connection running the main model shows that model, as apps read it,
        // while its own model stays enabled.
        const shown = runsMain
          ? modelCredentialDto(
              {
                ...row,
                isDefault: true,
                defaultModel: main.modelId,
                thinkingLevel: main.thinkingLevel ?? null,
              },
              plaintext,
            )
          : listed;
        return {
          ...shown,
          ...(shown.enabledModelIds
            ? {
                enabledModelIds: [
                  ...new Set([...shown.enabledModelIds, ...(listed.enabledModelIds ?? [])]),
                ],
              }
            : {}),
          ...(preference ? { preferenceRank: preferenceRanks.get(preference.credentialId) } : {}),
        };
      };
      const unreadable = runnable ? null : dto();
      const ciphertext = ciphertextById.get(row.secretId);
      if (!ciphertext) return unreadable;
      let plaintext: string;
      try {
        plaintext = await deps.secretStore.load(ciphertext, row.secretId);
        // A damaged secret leaves only its own connection out.
        parseModelSecret(plaintext);
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) throw error;
        return unreadable;
      }
      return dto(plaintext);
    }),
  );
  // A connection waiting to be signed in again cannot run anything until it is.
  return listed.filter(
    (credential): credential is NonNullable<typeof credential> =>
      credential !== null && !(runnable && credential.reconnectRequired),
  );
}
