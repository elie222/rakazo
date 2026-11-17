import type { SecretStore, VoiceProvider } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential, findModelCredential } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  resolveStoredModelAuth,
  withModelCredentialLock,
} from "../models/model-credential-refresh.js";
import { isRetiredModelCredentialError } from "../runtime/pi/models/pi-oauth.js";
import type { SecretCleanupDeps } from "../secrets/secret-cleanup.js";
import {
  createVoiceProvider,
  voiceCatalogEntry,
  voiceProviderMayUsePrivateEndpoint,
} from "./voice-factory.js";

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

/** Keep refresh failures and linked-connection refusals safe for display. */
export async function withVoiceConnection<T>(
  provider: string,
  linked: boolean,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!linked) throw error;
    const name = voiceCatalogEntry(provider)?.name ?? provider;
    if (error instanceof VoiceAccountError) {
      if (error.code === "VOICE_KEY_REJECTED") {
        throw new VoiceAccountError(
          error.code,
          `${name} didn't accept the Models connection for voice. Disconnect and paste an API key.`,
        );
      }
      throw error;
    }
    getLogger().warn("voice could not use the model connection", {
      provider,
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw new VoiceAccountError(
      undefined,
      `Couldn't use the ${name} connection from Models. Try again.`,
    );
  }
}

/**
 * The person's default voice connection where they are, its adapter, the bearer it sends and
 * whether that bearer comes from their Models connection. Null when they have none.
 */
export async function loadDefaultVoice(
  deps: DefaultVoiceDeps,
  scope: { userId: string; spaceId: string },
  signal?: AbortSignal,
): Promise<{
  credential: NonNullable<Awaited<ReturnType<typeof findDefaultVoiceCredential>>>;
  provider: VoiceProvider;
  apiKey: string;
  linked: boolean;
} | null> {
  const credential = await findDefaultVoiceCredential(deps.prisma, scope);
  const secret =
    credential &&
    (await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    }));
  if (!credential || !secret) return null;
  const provider = createVoiceProvider(credential.provider, {
    allowPrivateEndpoint: voiceProviderMayUsePrivateEndpoint(
      credential.provider,
      deps.mcpAllowPrivateEndpoint,
    ),
  });
  const plaintext = await deps.secretStore.load(secret.ciphertext, secret.id);
  const linked =
    isModelConnectionVoiceSecret(plaintext) &&
    Boolean(voiceCatalogEntry(credential.provider)?.modelConnection);
  const apiKey = await withVoiceConnection(credential.provider, linked, () =>
    resolveVoiceKey(deps, scope, credential.provider, plaintext, signal),
  );
  return { credential, provider, apiKey, linked };
}
