import type {
  MediaModelChoice,
  MediaModelRole,
  MediaModelRoleView,
  MediaModelsView,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { ModelRoleTarget, PrismaClient } from "@rakazo/db";
import { getModelRole, updateModelRole } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
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

/** The connection's models for the media, its default first when the list leaves it out. */
async function offeredModels(
  role: MediaModelRole,
  connection: MediaConnection,
): Promise<MediaModelOption[]> {
  const list = connection.media[ROLE_KIND[role]];
  if (!list) return [];
  const models = await list.models().catch((error: unknown) => {
    // An unreadable catalog still leaves the default, which runs without it.
    getLogger().warn("media.model_catalog_unavailable", { "media.role": role, error });
    return [];
  });
  return models.some((model) => model.id === list.defaultModel.id)
    ? models
    : [list.defaultModel, ...models];
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
      models: await offeredModels(role, connection),
    })),
  );
  const options = lists.flatMap(({ connection, models }) =>
    models.map((model) => ({
      credentialId: connection.id,
      modelId: model.id,
      label: offering.length > 1 ? `${model.label} (${connection.label})` : model.label,
    })),
  );
  const choice = mediaChoice(role, connections, chosen);
  const selected = choice && { credentialId: choice.connection.id, modelId: choice.model };
  // A chosen model a catalog no longer lists stays visible as what bots still use.
  if (
    selected &&
    !options.some(
      (option) =>
        option.credentialId === selected.credentialId && option.modelId === selected.modelId,
    )
  )
    options.unshift({ ...selected, label: selected.modelId });
  return { options, selected: selected ?? null };
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
  if (!connection) throw new MediaModelUnavailableError();
  const models = await offeredModels(role, connection);
  if (!models.some((model) => model.id === choice.modelId)) throw new MediaModelUnavailableError();
  await updateModelRole(prisma, target, role, {
    primary: {
      provider: connection.provider,
      modelId: choice.modelId,
      credentialId: connection.id,
    },
    backups: [],
  });
}
