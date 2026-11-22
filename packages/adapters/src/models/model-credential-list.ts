import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor, ModelCredential } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { comparePreferenceOrder, newestModelCredentialOrder } from "@rakazo/db";
import { modelCredentialDto } from "./model-connect.js";
import { resolveMemberMainModel } from "./model-roles.js";

/**
 * The member's model connections, newest first, as every model picker reads them. With
 * `showMainModel`, the connection running the member's main model shows that model, as apps
 * display it. A secret store outage propagates; any other unreadable secret lists its connection
 * without its secret details.
 */
export async function listModelCredentials(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load"> },
  actor: Pick<Actor, "userId" | "spaceId">,
  { showMainModel = false }: { showMainModel?: boolean } = {},
): Promise<ModelCredential[]> {
  const [rows, main] = await Promise.all([
    deps.prisma.userModelCredential.findMany({
      where: { userId: actor.userId },
      include: { userPreferences: { where: { userId: actor.userId } } },
      orderBy: newestModelCredentialOrder,
    }),
    showMainModel ? resolveMemberMainModel(deps, actor) : null,
  ]);
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
  return Promise.all(
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
      const ciphertext = ciphertextById.get(row.secretId);
      if (!ciphertext) return dto();
      try {
        return dto(await deps.secretStore.load(ciphertext, row.secretId));
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) throw error;
        return dto();
      }
    }),
  );
}
