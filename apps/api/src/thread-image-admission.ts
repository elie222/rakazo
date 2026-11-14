import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  codexLiveModel,
  connectionModelSettings,
  findConnectedBotModelCredential,
  knownModelImageInput,
  modelAcceptsImageInput,
  parseModelSecret,
  resolveMemberMainModel,
  runModelChoice,
  runtimeModelAcceptsImages,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appliedModelRole,
  findBotModelCredential,
  findModelCredential,
  findModelCredentialById,
} from "@rakazo/db";

type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};
export type ImageAdmissionRun = ModelChoice & {
  status: string;
  modelPinned?: boolean;
  trigger?: string | null;
};

/** Never refresh credentials while admitting a send. A supplied Codex catalog may answer image input. */
export async function assertThreadImageInput(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  blocks: MessageBlock[],
  run?: ImageAdmissionRun,
  configuration?: {
    secrets: Pick<SecretStore, "load">;
    deployment: { provider: string; model: string } | null;
    hostedProvider?: string;
    codexCatalog?: CodexLiveCatalog;
  },
) {
  if (!blocks.some((block) => block.kind === "image")) return;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!bot) return;
  // A running turn has already selected its model, including any backup switch.
  const running = run?.status === "running" && run.modelProvider && run.modelId;
  const override = running ? run : run ? runModelChoice(run, bot) : bot;
  const overrideCredential =
    override.modelProvider && override.modelId
      ? configuration
        ? await findConnectedBotModelCredential(
            prisma,
            configuration.secrets,
            actor,
            botId,
            override.modelProvider,
            override.modelId,
          )
        : await findBotModelCredential(
            prisma,
            actor,
            botId,
            override.modelProvider,
            override.modelId,
          )
      : null;
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    main: configuration
      ? await resolveMemberMainModel({ prisma, secretStore: configuration.secrets }, actor)
      : await mainModelWithoutSecrets(prisma, actor),
    defaults: {
      settings: await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      deployment: configuration?.deployment ?? null,
    },
    hostedProvider: configuration?.hostedProvider,
  });
  const provider = running ? run.modelProvider : selected.provider;
  const id = running ? run.modelId : selected.id;
  if (!provider || !id) return;
  let supportsImages = knownModelImageInput(provider, id);
  const credential = running ? overrideCredential : selected.credential;
  if (supportsImages === undefined && configuration && credential) {
    // A model the catalog cannot describe reads images when its settings say so; without
    // one its capability is unknown, so the user is asked to configure it.
    const secret = await loadModelSecret(prisma, configuration.secrets, actor, credential);
    if (secret) {
      const settings = connectionModelSettings(secret, provider, id, {
        defaultModel: credential.defaultModel,
        supportsImages: await legacyImageInput(prisma, actor, credential.id),
      });
      supportsImages =
        provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? modelAcceptsImageInput(provider, id, settings.images) || settings.images
          : settings.images;
    }
  }
  if (provider === CHATGPT_OAUTH_PROVIDER && configuration?.codexCatalog && credential) {
    const secret = await loadModelSecret(prisma, configuration.secrets, actor, credential);
    const live = secret
      ? await codexLiveModel(configuration.codexCatalog, actor.userId, secret, id, {
          waitMs: 0,
        }).catch(() => undefined)
      : undefined;
    if (live?.supportsImages !== undefined) supportsImages = live.supportsImages;
  }
  const unknownInput = supportsImages === undefined && !runtimeModelAcceptsImages(provider, id);
  if (supportsImages === false || unknownInput)
    throw new ORPCError("CONFLICT", {
      message: unknownInput ? MODEL_IMAGE_INPUT_UNKNOWN : MODEL_IMAGE_INPUT_ERROR,
      data: { reason: "model_image_input_unsupported" },
    });
}

/** An unreadable secret describes nothing, so the model's image input stays unknown. */
async function loadModelSecret(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  actor: Actor,
  credential: { secretId: string },
) {
  const row = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
  });
  if (!row) return undefined;
  try {
    return parseModelSecret(await secrets.load(row.ciphertext, row.id));
  } catch {
    return undefined;
  }
}

/** Connections saved before per-model image settings recorded the capability on the row. */
async function legacyImageInput(prisma: PrismaClient, actor: Actor, credentialId: string) {
  return (
    await prisma.userModelCredential.findFirst({
      where: { id: credentialId, userId: actor.userId },
      select: { supportsImages: true },
    })
  )?.supportsImages;
}

/** The main model as resolveMemberMainModel picks it, without reading secrets. */
async function mainModelWithoutSecrets(prisma: PrismaClient, actor: Actor) {
  const { primary } = await appliedModelRole(prisma, actor, "main");
  if (!primary) return null;
  return {
    ...primary,
    credential: primary.credentialId
      ? await findModelCredentialById(prisma, actor, primary.credentialId, primary.provider)
      : await findModelCredential(prisma, actor, primary.provider, primary.modelId),
  };
}
