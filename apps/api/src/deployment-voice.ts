import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  createVoiceProvider,
  DEPLOYMENT_VOICE_RECORD,
  deploymentVoiceProviders,
  findSavedDeploymentVoice,
  isDeploymentVoiceProvider,
  resolveDeploymentVoiceEnv,
} from "@rakazo/adapters";
import type {
  Actor,
  DeploymentVoiceSettings,
  DeploymentVoiceUpdate,
  VoiceInfo,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import { forgetDeploymentSecret } from "./deployment-secrets.js";
import type { RouterDeps } from "./router.js";
import { voiceContext } from "./voice.js";

export interface DeploymentVoiceDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
  env: Pick<RouterDeps["env"], "adminEmails">;
}

function view(saved: { provider: string; voiceId: string } | null): DeploymentVoiceSettings {
  return {
    provider: saved?.provider ?? null,
    voiceId: saved?.voiceId ?? "",
    keySaved: Boolean(saved),
    environmentProvider: resolveDeploymentVoiceEnv()?.provider ?? null,
    providers: deploymentVoiceProviders(),
  };
}

export async function getDeploymentVoiceSettings(
  deps: DeploymentVoiceDeps,
  actor: Actor,
): Promise<DeploymentVoiceSettings> {
  await requireAdmin(deps, actor.userId);
  return view(await findSavedDeploymentVoice(deps.prisma));
}

/** The saved provider's voices, for an admin choosing one. */
export async function listDeploymentVoices(
  deps: DeploymentVoiceDeps,
  actor: Actor,
  signal?: AbortSignal,
): Promise<VoiceInfo[]> {
  await requireAdmin(deps, actor.userId);
  const saved = await findSavedDeploymentVoice(deps.prisma);
  if (!saved) return [];
  const apiKey = await deps.secrets.load(saved.ciphertext, DEPLOYMENT_VOICE_RECORD);
  return createVoiceProvider(saved.provider).listVoices(apiKey, voiceContext(actor, signal));
}

/** Writes the row and returns the ciphertext it replaced, read in the same transaction. */
function saveRow(
  deps: DeploymentVoiceDeps,
  reason: string,
  data: {
    defaultVoiceProvider: string | null;
    defaultVoiceId: string | null;
    defaultVoiceCredentialCipher: string | null;
  },
) {
  return withTransactionRetry(() =>
    runAsSystem(reason, () =>
      deps.prisma.$transaction(
        async (tx) => {
          const current = await tx.deploymentSettings.findUnique({
            where: { id: "default" },
            select: { defaultVoiceCredentialCipher: true },
          });
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: { id: "default", ...data },
            update: data,
          });
          return current?.defaultVoiceCredentialCipher ?? null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
}

export async function updateDeploymentVoiceSettings(
  deps: DeploymentVoiceDeps,
  actor: Actor,
  input: DeploymentVoiceUpdate & { signal?: AbortSignal },
): Promise<DeploymentVoiceSettings> {
  await requireAdmin(deps, actor.userId);
  // A remote secret store keeps every saved value until it is deleted there too.
  const forget = async (ciphertext: string | null) => {
    if (ciphertext) await forgetDeploymentSecret(deps.secrets, ciphertext, DEPLOYMENT_VOICE_RECORD);
  };
  if (input.provider === null) {
    // Clearing falls back to the environment's voice, if any.
    await forget(
      await saveRow(deps, "an admin removes the deployment's voice", {
        defaultVoiceProvider: null,
        defaultVoiceId: null,
        defaultVoiceCredentialCipher: null,
      }),
    );
    return view(null);
  }
  const provider = input.provider;
  if (!isDeploymentVoiceProvider(provider)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." });
  }
  // Blank keeps the saved key, so an admin never has to see it again.
  const previous = await findSavedDeploymentVoice(deps.prisma);
  const apiKey =
    input.apiKey.trim() ||
    (previous?.provider === provider
      ? await deps.secrets.load(previous.ciphertext, DEPLOYMENT_VOICE_RECORD)
      : "");
  if (apiKey.length < 8) throw new ORPCError("BAD_REQUEST", { message: "Enter an API key." });
  const voices = createVoiceProvider(provider);
  const context = voiceContext(actor, input.signal);
  const verified = await voices.verify(apiKey, context);
  if (!verified.ok) {
    throw new ORPCError("BAD_REQUEST", { message: verified.message ?? "That key was rejected." });
  }
  // A voice the key cannot use would leave everyone without speech, so the one saved must be
  // among the key's voices: a voice kept from another key or provider gives way to its first one.
  // A provider that cannot list its voices keeps the one asked for.
  const asked = input.voiceId?.trim() || "";
  const listed = await voices.listVoices(apiKey, context).catch(() => undefined);
  // An account with no voices yet could not speak for anyone, whatever voice was asked for.
  if (listed?.length === 0)
    throw new ORPCError("BAD_REQUEST", {
      message: "That account has no voices yet. Add one with the provider, then save again.",
    });
  const voiceId =
    listed?.length && !listed.some((voice) => voice.id === asked) ? listed[0]!.id : asked;
  // Owned by the deployment row, not a user or space, so no account deletion removes it.
  const stored = await deps.secrets.put(apiKey, context, { recordId: DEPLOYMENT_VOICE_RECORD });
  let replaced: string | null;
  try {
    replaced = await saveRow(deps, "an admin sets the deployment's voice", {
      defaultVoiceProvider: provider,
      defaultVoiceId: voiceId,
      defaultVoiceCredentialCipher: stored.ciphertext,
    });
  } catch (error) {
    await forget(stored.ciphertext);
    throw error;
  }
  if (replaced !== stored.ciphertext) await forget(replaced);
  return view({ provider, voiceId });
}
