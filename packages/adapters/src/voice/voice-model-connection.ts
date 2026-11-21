import type { SecretStore, VoiceProvider } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  findDefaultVoiceCredential,
  findModelCredential,
  findModelCredentialById,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  resolveStoredModelAuth,
  withModelCredentialLock,
} from "../models/model-credential-refresh.js";
import {
  MODEL_PROVIDER_NOT_ALLOWED_ERROR,
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import { isRetiredModelCredentialError } from "../runtime/pi/models/pi-oauth.js";
import type { SecretCleanupDeps } from "../secrets/secret-cleanup.js";
import {
  createVoiceProvider,
  voiceCatalogEntry,
  voiceProviderMayUsePrivateEndpoint,
} from "./voice-factory.js";
import { VoiceProviderUnavailableError } from "./voice-http.js";

/**
 * A voice connection's secret when it authenticates with one of the account's model connections
 * to the same provider instead of a key of its own. It holds no token: each request reads the
 * model connection, so a refresh or reconnect there carries over. Without `credentialId`, as
 * saved before a connection could be chosen, it uses the provider's preferred connection.
 */
export function modelConnectionVoiceSecret(credentialId?: string): string {
  return JSON.stringify(
    credentialId ? { kind: "model_connection", credentialId } : { kind: "model_connection" },
  );
}

/** The model connection a voice secret names, or undefined when the secret is a key. */
export function parseModelConnectionVoiceSecret(
  plaintext: string,
): { credentialId?: string } | undefined {
  // A pasted key is never parsed: only the exact shape written above counts.
  if (!plaintext.startsWith('{"kind":"model_connection"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) return undefined;
  if (parsed.kind !== "model_connection") return undefined;
  const credentialId = "credentialId" in parsed ? parsed.credentialId : undefined;
  if (credentialId !== undefined && (typeof credentialId !== "string" || !credentialId)) {
    return undefined;
  }
  // Anything but exactly what modelConnectionVoiceSecret writes, such as an extra field, is a key.
  if (plaintext !== modelConnectionVoiceSecret(credentialId)) return undefined;
  return credentialId ? { credentialId } : {};
}

export function isModelConnectionVoiceSecret(plaintext: string): boolean {
  return parseModelConnectionVoiceSecret(plaintext) !== undefined;
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
  const link = parseModelConnectionVoiceSecret(plaintext);
  if (!link || !voiceCatalogEntry(provider)?.modelConnection) return plaintext;
  // A model connection the deployment's allowlist refuses is not borrowed for voice either.
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) {
    throw new VoiceAccountError(undefined, MODEL_PROVIDER_NOT_ALLOWED_ERROR);
  }
  const missing = () =>
    new VoiceAccountError(
      undefined,
      `Connect ${voiceCatalogEntry(provider)?.name ?? provider} in Models settings.`,
    );
  const owner = { userId: scope.userId };
  const credential = link.credentialId
    ? await findModelCredentialById(deps.prisma, owner, link.credentialId, provider)
    : await findModelCredential(deps.prisma, owner, provider);
  if (!credential) throw missing();
  return withModelCredentialLock(credential.secretId, async () => {
    const row = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    });
    if (!row) throw missing();
    const stored = await deps.secretStore.load(row.ciphertext, row.id);
    try {
      const { secret, apiKey } = await resolveStoredModelAuth(
        deps.prisma,
        deps.secretStore,
        scope,
        credential,
        stored,
        provider,
        { signal },
      );
      if (!apiKey) throw missing();
      // Audio requests carry no retention routing, so a protected connection is never borrowed.
      if (secret.kind === "api_key" && secret.zeroDataRetention) {
        throw new VoiceAccountError(
          undefined,
          "This model connection keeps zero data retention, which voice can't enforce. Add a separate key.",
        );
      }
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
    const outage = voiceOutage(error);
    if (outage) {
      getLogger().warn("voice provider unavailable", {
        provider,
        reason: outage.cause instanceof Error ? outage.cause.name : "server error",
      });
      throw outage;
    }
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

/** A provider outage or a request it left unanswered past its deadline, as one error to wait out. */
export function voiceOutage(error: unknown): VoiceProviderUnavailableError | undefined {
  if (error instanceof VoiceProviderUnavailableError) return error;
  if (error instanceof Error && error.name === "TimeoutError")
    return new VoiceProviderUnavailableError(undefined, { cause: error });
  return undefined;
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
