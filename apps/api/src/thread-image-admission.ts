import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  findConnectedModelCredential,
  knownModelImageInput,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  parseModelSecret,
  resolveRuntimeModel,
  runModelChoice,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultModelCredential, findModelCredential } from "@rakazo/db";

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

/** Only local reads: never refresh credentials or probe a provider while admitting a send. */
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
  },
) {
  if (!blocks.some((block) => block.kind === "image")) return;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: actor.userId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!bot) return;
  // A running turn has already selected its model, including any backup switch.
  const running = run?.status === "running" && run.modelProvider && run.modelId;
  const override = running ? run : run ? runModelChoice(run, bot) : bot;
  const overrideCredential =
    override.modelProvider && override.modelId
      ? configuration
        ? await findConnectedModelCredential(
            prisma,
            configuration.secrets,
            actor,
            override.modelProvider,
            override.modelId,
          )
        : await findModelCredential(prisma, actor, override.modelProvider, override.modelId)
      : null;
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    defaultCredential: await findDefaultModelCredential(prisma, actor),
    settings: await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    deployment: configuration?.deployment ?? null,
    hostedProvider: configuration?.hostedProvider,
  });
  const provider = running ? run.modelProvider : selected.provider;
  const id = running ? run.modelId : selected.id;
  if (!provider || !id) return;
  let supportsImages = knownModelImageInput(provider, id);
  if (provider === "openai-compatible" && configuration) {
    const credential = running ? overrideCredential : selected.credential;
    if (credential) {
      const row = await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: actor.userId, spaceId: null },
      });
      if (row) {
        const legacy = await prisma.userModelCredential.findFirst({
          where: { id: credential.id, userId: actor.userId },
          select: { supportsImages: true },
        });
        const secret = parseModelSecret(await configuration.secrets.load(row.ciphertext, row.id));
        if (secret.kind === "openai_compatible") {
          supportsImages =
            modelAcceptsImageInput(provider, id) ||
            modelIdSupportsImages(secret.visionModelIds, id) ||
            (secret.visionModelIds === undefined &&
              credential.defaultModel?.trim() === id.trim() &&
              legacy?.supportsImages === true);
        }
      }
    }
  }
  const unknownInput =
    supportsImages === undefined &&
    !resolveRuntimeModel({ provider, id }).model?.input.includes("image");
  if (supportsImages === false || unknownInput)
    throw new ORPCError("CONFLICT", {
      message: unknownInput ? MODEL_IMAGE_INPUT_UNKNOWN : MODEL_IMAGE_INPUT_ERROR,
      data: { reason: "model_image_input_unsupported" },
    });
}
