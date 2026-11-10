import type { AdapterContext, SecretStore, VoiceProvider } from "@rakazo/adapter-kit";
import type { VoiceCatalogEntry } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { OPENAI_COMPATIBLE_VOICE_PROVIDER_ID } from "./openai-compatible-voice.js";
import { isSpeechModelId, VOICE_CATALOG, voiceCatalogEntry } from "./voice-factory.js";

/** Record id binding the deployment's encrypted voice key to its settings row. */
export const DEPLOYMENT_VOICE_RECORD = "deployment-voice";

/**
 * The voice everyone without their own connection uses: an admin's choice in Settings,
 * else the operator's environment. The key is read only when a call needs it.
 */
export interface DeploymentVoice {
  provider: string;
  /** Empty uses the provider's first voice. */
  voiceId: string;
  /** Empty uses the provider's default speech model. */
  speechModel: string;
  source: "settings" | "environment";
  loadKey(): Promise<string>;
}

/** Hosted providers one key can serve for a whole deployment. */
export function deploymentVoiceProviders(): VoiceCatalogEntry[] {
  return VOICE_CATALOG.filter((entry) => entry.id !== OPENAI_COMPATIBLE_VOICE_PROVIDER_ID);
}

export function isDeploymentVoiceProvider(id: string): boolean {
  return deploymentVoiceProviders().some((entry) => entry.id === id);
}

let invalidEnvironmentWarned = false;

/**
 * The operator's voice: `VOICE_DEFAULT_PROVIDER` (a hosted catalog id) with
 * `VOICE_DEFAULT_API_KEY`, and optionally `VOICE_DEFAULT_VOICE_ID` and
 * `VOICE_DEFAULT_SPEECH_MODEL`. Voice has its own key name, so no model library reads it
 * as a model key and starts billing runs to it.
 */
export function resolveDeploymentVoiceEnv(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.VOICE_DEFAULT_PROVIDER?.trim() ?? "";
  const apiKey = env.VOICE_DEFAULT_API_KEY?.trim() ?? "";
  if (!provider && !apiKey) return null;
  if (!isDeploymentVoiceProvider(provider) || !apiKey) {
    if (!invalidEnvironmentWarned) {
      invalidEnvironmentWarned = true;
      // Never the values: a key pasted into the wrong variable would reach the log.
      getLogger().warn(
        "Ignoring the deployment voice: set VOICE_DEFAULT_PROVIDER to a hosted voice provider and VOICE_DEFAULT_API_KEY",
      );
    }
    return null;
  }
  const speechModel = env.VOICE_DEFAULT_SPEECH_MODEL?.trim() ?? "";
  return {
    provider,
    apiKey,
    voiceId: env.VOICE_DEFAULT_VOICE_ID?.trim() ?? "",
    speechModel:
      voiceCatalogEntry(provider)?.speechModel && isSpeechModelId(speechModel) ? speechModel : "",
  };
}

const SAVED_VOICE_COLUMNS = {
  defaultVoiceProvider: true,
  defaultVoiceId: true,
  defaultVoiceCredentialCipher: true,
} as const;

/** The admin's saved choice, read fresh so a change applies in every process at once. */
export async function findSavedDeploymentVoice(prisma: Pick<PrismaClient, "deploymentSettings">) {
  const row = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: SAVED_VOICE_COLUMNS,
  });
  const provider = row?.defaultVoiceProvider;
  const ciphertext = row?.defaultVoiceCredentialCipher;
  if (!provider || !ciphertext || !isDeploymentVoiceProvider(provider)) return null;
  return { provider, voiceId: row.defaultVoiceId ?? "", ciphertext };
}

/** Settings first, then the environment; null when the deployment has no voice. */
export async function findDeploymentVoice(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  secrets: Pick<SecretStore, "load">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentVoice | null> {
  const saved = await findSavedDeploymentVoice(prisma);
  if (saved) {
    return {
      provider: saved.provider,
      voiceId: saved.voiceId,
      speechModel: "",
      source: "settings",
      loadKey: () => secrets.load(saved.ciphertext, DEPLOYMENT_VOICE_RECORD),
    };
  }
  const configured = resolveDeploymentVoiceEnv(env);
  if (!configured) return null;
  const { apiKey, ...voice } = configured;
  return { ...voice, source: "environment", loadKey: async () => apiKey };
}

/** Whether the deployment has a voice, without reading its key. */
export async function hasDeploymentVoice(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: NodeJS.ProcessEnv = process.env,
) {
  return Boolean(resolveDeploymentVoiceEnv(env)) || Boolean(await findSavedDeploymentVoice(prisma));
}

/**
 * Whether the deployment's voice can speak: there is one and its key can be read. A saved key
 * whose secret is gone or unreadable cannot.
 */
export async function deploymentVoiceSpeaks(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  secrets: Pick<SecretStore, "load">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const voice = await findDeploymentVoice(prisma, secrets, env);
  if (!voice) return false;
  const key = await voice.loadKey().catch(() => "");
  return key.trim().length > 0;
}

/** The last provider and key whose first voice was listed, kept as a digest. */
let firstVoice: { digest: string; voiceId: string } | null = null;

/** The deployment's voice, or its provider's first one when none was chosen. */
export async function deploymentVoiceId(
  voice: Pick<DeploymentVoice, "provider" | "voiceId">,
  apiKey: string,
  provider: Pick<VoiceProvider, "listVoices">,
  context: AdapterContext,
): Promise<string> {
  if (voice.voiceId) return voice.voiceId;
  const digest = credentialDigest(`${voice.provider}\u0000${apiKey}`);
  if (firstVoice?.digest === digest) return firstVoice.voiceId;
  const [first] = await provider.listVoices(apiKey, context);
  if (!first) return "";
  firstVoice = { digest, voiceId: first.id };
  return first.id;
}
