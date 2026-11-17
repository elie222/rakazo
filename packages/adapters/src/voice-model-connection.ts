import type { SecretStore, VoiceProvider } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential, findModelCredential } from "@rakazo/db";
import { resolveStoredModelAuth, withModelCredentialLock } from "./model-credential-refresh.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_VOICE_PROVIDER_ID } from "./providers/voice/openai-compatible/openai-compatible-voice.js";
import type { SecretCleanupDeps } from "./secret-cleanup.js";
import { createVoiceProvider, voiceCatalogEntry } from "./voice-factory.js";

/**
 * A voice connection's secret when it authenticates with the account's model connection to the
 * same provider instead of a key of its own. It holds no token: each request reads the model
 * connection, so a refresh or reconnect there carries over.
 */
export const MODEL_CONNECTION_VOICE_SECRET = JSON.stringify({ kind: "model_connection" });

export function isModelConnectionVoiceSecret(plaintext: string): boolean {
  return plaintext === MODEL_CONNECTION_VOICE_SECRET;
}

export type VoiceKeyDeps = {
  prisma: Pick<PrismaClient, "$transaction" | "userModelCredential" | "userModelPreference"> &
    SecretCleanupDeps["prisma"];
  secretStore: Pick<SecretStore, "load" | "put" | "delete" | "isRemote">;
};

/**
 * The bearer a voice adapter sends: the stored key, or a current one from the account's model
 * connection to the provider, refreshed and retired under the same lock a model run uses.
 */
export async function resolveVoiceKey(
  deps: VoiceKeyDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  plaintext: string,
  signal?: AbortSignal,
): Promise<string> {
  // Only a provider the catalog lets use the model connection may; elsewhere it is a pasted key.
  if (!isModelConnectionVoiceSecret(plaintext) || !voiceCatalogEntry(provider)?.modelConnection) {
    return plaintext;
  }
  const missing = () =>
    new VoiceAccountError(
      undefined,
      `Connect ${voiceCatalogEntry(provider)?.name ?? provider} in Models settings.`,
    );
  const credential = await findModelCredential(deps.prisma, { userId: scope.userId }, provider);
  if (!credential) throw missing();
  return withModelCredentialLock(credential.secretId, async () => {
    const row = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    });
    if (!row) throw missing();
    const stored = await deps.secretStore.load(row.ciphertext, row.id);
    try {
      const { apiKey } = await resolveStoredModelAuth(
        deps.prisma,
        deps.secretStore,
        scope,
        credential,
        stored,
        provider,
        { signal },
      );
      if (!apiKey) throw missing();
      return apiKey;
    } catch (error) {
      if (isRetiredModelCredentialError(error)) throw missing();
      throw error;
    }
  });
}

export type DefaultVoiceDeps = {
  prisma: PrismaClient;
  secretStore: VoiceKeyDeps["secretStore"];
  /** The instance flag (`MCP_ALLOW_PRIVATE_ENDPOINT`). */
  mcpAllowPrivateEndpoint?: boolean;
};

/**
 * The person's default voice connection where they are, its adapter and the bearer it sends.
 * Null when they have none.
 */
export async function loadDefaultVoice(
  deps: DefaultVoiceDeps,
  scope: { userId: string; spaceId: string },
  signal?: AbortSignal,
): Promise<{
  credential: NonNullable<Awaited<ReturnType<typeof findDefaultVoiceCredential>>>;
  provider: VoiceProvider;
  apiKey: string;
} | null> {
  const credential = await findDefaultVoiceCredential(deps.prisma, scope);
  const secret =
    credential &&
    (await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    }));
  if (!credential || !secret) return null;
  // A self-hosted speech server on a private address is limited like model endpoints.
  const provider = createVoiceProvider(credential.provider, {
    allowPrivateEndpoint:
      credential.provider === OPENAI_COMPATIBLE_VOICE_PROVIDER_ID &&
      deps.mcpAllowPrivateEndpoint === true,
  });
  const plaintext = await deps.secretStore.load(secret.ciphertext, secret.id);
  const apiKey = await resolveVoiceKey(deps, scope, credential.provider, plaintext, signal);
  return { credential, provider, apiKey };
}
