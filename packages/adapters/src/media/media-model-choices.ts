import type {
  MediaModelChoice,
  MediaModelRole,
  MediaModelRoleView,
  MediaModelsView,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { ModelRoleTarget, PrismaClient } from "@rakazo/db";
import { getModelRole, updateModelRole } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { isMediaModelId } from "./images-api.js";
import type { MediaModelOption } from "./media-models.js";
import type { MediaConnection } from "./media-sources.js";
import { mediaChoice, mediaConnections, ROLE_KIND } from "./media-sources.js";

type ChoiceClient = Pick<
  PrismaClient,
  "userModelCredential" | "userModelRoleChoice" | "spaceModelRoleChoice"
>;

/** A media model that is not one the connection offers for that media. */
export class MediaModelUnavailableError extends ClientError {
  constructor() {
    super(
      "BAD_REQUEST",
      "This model is not available on that connection.",
      "media_model_unavailable",
    );
    this.name = "MediaModelUnavailableError";
  }
}

/**
 * The connection's models for the media, its default first when the list leaves it out.
 * `listed` is false when the catalog could not be read, leaving only the default.
 */
async function offeredModels(
  role: MediaModelRole,
  connection: MediaConnection,
): Promise<{ models: MediaModelOption[]; listed: boolean }> {
  const list = connection.media[ROLE_KIND[role]];
  if (!list) return { models: [], listed: true };
  const read = await bestEffort(`read the ${role} model catalog`, list.models());
  const models = read ?? [];
  return {
    models: models.some((model) => model.id === list.defaultModel.id)
      ? models
      : [list.defaultModel, ...models],
    listed: read !== undefined,
  };
}

async function roleView(
  role: MediaModelRole,
  connections: MediaConnection[],
  chosen: { credentialId?: string; modelId: string } | null,
): Promise<MediaModelRoleView> {
  const offering = connections.filter((connection) => connection.media[ROLE_KIND[role]]);
  const lists = await Promise.all(
    offering.map(async (connection) => ({
      connection,
      models: (await offeredModels(role, connection)).models,
    })),
  );
  const options = lists.flatMap(({ connection, models }) =>
    models.map((model) => ({
      credentialId: connection.id,
      modelId: model.id,
      label: model.label,
      provider: connection.provider,
      connectionLabel: connection.label,
    })),
  );
  const choice = mediaChoice(role, connections, chosen);
  if (!choice) return { options, selected: null };
  const selected = { credentialId: choice.connection.id, modelId: choice.model };
  // A chosen model a catalog no longer lists stays visible as what bots still use.
  if (
    !options.some(
      (option) =>
        option.credentialId === selected.credentialId && option.modelId === selected.modelId,
    )
  )
    options.unshift({
      ...selected,
      label: selected.modelId,
      provider: choice.connection.provider,
      connectionLabel: choice.connection.label,
    });
  return { options, selected };
}

/** The image and video models the member's own connections offer, and the ones bots use. */
export async function mediaModelsView(
  prisma: ChoiceClient,
  target: ModelRoleTarget,
): Promise<MediaModelsView> {
  const [connections, image, video] = await Promise.all([
    mediaConnections(prisma, target.userId),
    getModelRole(prisma, target, "image"),
    getModelRole(prisma, target, "video"),
  ]);
  const [imageView, videoView] = await Promise.all([
    roleView("image", connections, image.primary),
    roleView("video", connections, video.primary),
  ]);
  return { image: imageView, video: videoView };
}

/** Saves the member's model for one kind of media, which must be one its connection offers. */
export async function setMediaModel(
  prisma: PrismaClient,
  target: { userId: string; spaceId: string; scope?: ModelRoleTarget["scope"] },
  role: MediaModelRole,
  choice: MediaModelChoice,
): Promise<void> {
  const connection = (await mediaConnections(prisma, target.userId)).find(
    (item) => item.id === choice.credentialId,
  );
  if (!connection?.media[ROLE_KIND[role]]) throw new MediaModelUnavailableError();
  const { models, listed } = await offeredModels(role, connection);
  // While the catalog is unreadable, a pick from an earlier list is kept rather than refused.
  if (
    listed ? !models.some((model) => model.id === choice.modelId) : !isMediaModelId(choice.modelId)
  )
    throw new MediaModelUnavailableError();
  await updateModelRole(prisma, target, role, {
    primary: {
      provider: connection.provider,
      modelId: choice.modelId,
      credentialId: connection.id,
    },
    backups: [],
  });
}
