import {
  listPiCatalog,
  listVoiceCatalog,
  modelProviderAllowed,
  modelProviderAllowlist,
  parseModelConnectionVoiceSecret,
  voiceCatalogEntry,
} from "@rakazo/adapters";
import type { Actor, VoiceCatalogEntry } from "@rakazo/contracts";
import { connectionDisplayName } from "@rakazo/contracts";
import { modelCredentialProviderFilter, newestModelCredentialOrder } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { VoiceDeps } from "./voice.js";

/**
 * The catalog as this account sees it. A provider that can use a model connection lists the
 * account's connections to it, or offers its Models sign-in when there are none.
 */
export async function accountVoiceCatalog(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId">,
): Promise<VoiceCatalogEntry[]> {
  const catalog = listVoiceCatalog({ allowPrivateEndpoint: deps.env?.mcpAllowPrivateEndpoint });
  const allowlist = modelProviderAllowlist();
  return Promise.all(
    catalog.map(async ({ modelConnection, ...entry }) => {
      // A model provider the deployment refuses can't lend voice a connection or a sign-in.
      if (!modelConnection || !modelProviderAllowed(allowlist, entry.id)) return entry;
      const rows = await deps.prisma.userModelCredential.findMany({
        where: { userId: actor.userId, provider: modelCredentialProviderFilter(entry.id) },
        orderBy: newestModelCredentialOrder,
        select: { id: true, provider: true, label: true },
      });
      const models = listPiCatalog().filter((model) => model.provider === entry.id);
      if (rows.length) {
        // Named as Models names them, so a connection reads the same in both places.
        const providerName = models[0]?.providerName ?? entry.name;
        const modelConnections = rows.map((row) => ({
          id: row.id,
          label: connectionDisplayName(row, providerName),
        }));
        return { ...entry, modelConnection, modelConnections };
      }
      const modelSignIn = models.find((model) => model.signIn)?.oauthLabel;
      return modelSignIn ? { ...entry, modelSignIn } : entry;
    }),
  );
}

/**
 * Whether a connection stores its own key, or else which model connection it uses. Only a
 * provider that can use the account's model connection opens its secret to tell; one that
 * cannot be read counts as a key.
 */
export async function voiceCredentialLink(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId">,
  row: { provider: string; secretId: string },
): Promise<{ hasKey: boolean; modelCredentialId?: string }> {
  if (!voiceCatalogEntry(row.provider)?.modelConnection) return { hasKey: true };
  const secret = await deps.prisma.secret.findFirst({
    where: { id: row.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return { hasKey: true };
  try {
    return voiceLinkOf(await deps.secrets.load(secret.ciphertext, secret.id));
  } catch (error) {
    getLogger().warn("could not read voice credential link", {
      provider: row.provider,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { hasKey: true };
  }
}

export function voiceLinkOf(plaintext: string): { hasKey: boolean; modelCredentialId?: string } {
  const link = parseModelConnectionVoiceSecret(plaintext);
  return link ? { hasKey: false, modelCredentialId: link.credentialId } : { hasKey: true };
}
