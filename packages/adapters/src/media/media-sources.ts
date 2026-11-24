import type { MediaGenerationProvider, SecretStore } from "@rakazo/adapter-kit";
import type { MediaModelRole, ModelRoleSettings } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appliedModelRole,
  JsonColumnMismatchError,
  newestModelCredentialOrder,
  readJsonColumn,
  reportJsonColumnOnce,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import {
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import type { ModelProviderDefinition } from "../models/model-provider-registry.js";
import { modelProviderDefinition, modelProviders } from "../models/model-provider-registry.js";
import { parseModelSecret } from "../models/model-secret.js";
import type { MediaKind } from "./media-models.js";

/**
 * What made a generation, saved on its job: the run owner's own model connection, which costs
 * them nothing on Rakazo's side, or the deployment's hosted provider, which metering charges.
 */
export const mediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection"),
    connectionId: z.string().min(1),
    // compat-shim(after v0.15.0): jobs the previous release saves name no model; it made the default.
    model: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("hosted") }),
]);
export type MediaSourceRecord = z.infer<typeof mediaSourceSchema>;

const HOSTED: MediaSourceRecord = { kind: "hosted" };

const mediaJobRequestSchema = z.object({
  // compat-shim(after v0.15.0): jobs the previous release saves carry no source; all were hosted.
  mediaSource: mediaSourceSchema.optional().transform((source) => source ?? HOSTED),
});

/** Where a media job was made; undefined when its saved request is unreadable. */
export function readMediaJobSource(job: { id: string; request: unknown }) {
  try {
    return readJsonColumn(
      mediaJobRequestSchema,
      job.request,
      { table: "external_effects", column: "request", id: job.id },
      "reject",
    ).mediaSource;
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    reportJsonColumnOnce("Unreadable media job request", error.row);
    return undefined;
  }
}

export interface ResolvedMediaSource {
  record: MediaSourceRecord;
  provider: MediaGenerationProvider;
}

/** Where a run's media of one kind comes from, settled only when a tool first uses it. */
export type MediaSource = () => Promise<ResolvedMediaSource | undefined>;

export interface RunMediaSources {
  image?: MediaSource;
  video?: MediaSource;
}

export interface MediaSourceDeps {
  prisma: Pick<
    PrismaClient,
    | "userModelCredential"
    | "secret"
    | "spaceSettingOverride"
    | "userModelRoleChoice"
    | "spaceModelRoleChoice"
  >;
  secretStore: Pick<SecretStore, "load">;
  /** The deployment-wide provider, used when the owner has no connection that makes the media. */
  mediaGeneration?: MediaGenerationProvider;
}

type ConnectionMedia = NonNullable<ModelProviderDefinition["media"]>;

export function connectionMedia(provider: string): ConnectionMedia | undefined {
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) return undefined;
  return modelProviderDefinition(provider)?.media;
}

export const ROLE_KIND = { image: "images", video: "video" } as const satisfies Record<
  MediaModelRole,
  MediaKind
>;

/** The owner's connections whose provider makes some media, newest first. */
export async function mediaConnections(
  prisma: Pick<PrismaClient, "userModelCredential">,
  userId: string,
) {
  const connections = await prisma.userModelCredential.findMany({
    where: { userId, provider: { in: Object.keys(modelProviders).filter(connectionMedia) } },
    orderBy: newestModelCredentialOrder,
    select: { id: true, provider: true, label: true },
  });
  return connections.flatMap((connection) => {
    const media = connectionMedia(connection.provider);
    return media ? [{ ...connection, media }] : [];
  });
}
export type MediaConnection = Awaited<ReturnType<typeof mediaConnections>>[number];

/**
 * The connection and model a kind of media runs on: the member's choice while its connection
 * remains and makes that media, otherwise the newest connection that does, with its default.
 */
export function mediaChoice(
  role: MediaModelRole,
  connections: MediaConnection[],
  chosen: { credentialId?: string; modelId: string } | null,
): { connection: MediaConnection; model: string } | undefined {
  const kind = ROLE_KIND[role];
  const pinned = connections.find((item) => item.id === chosen?.credentialId);
  if (chosen && pinned?.media[kind]) return { connection: pinned, model: chosen.modelId };
  const newest = connections.find((item) => item.media[kind]);
  return newest && { connection: newest, model: newest.media[kind]!.defaultModel.id };
}

/** Builds the connection's media provider from its stored key; undefined once it is gone. */
async function connectionProvider(
  deps: MediaSourceDeps,
  userId: string,
  connectionId: string,
  models: { imageModel?: string; videoModel?: string },
): Promise<MediaGenerationProvider | undefined> {
  const connection = await deps.prisma.userModelCredential.findFirst({
    where: { id: connectionId, userId },
    select: { provider: true, secretId: true },
  });
  const media = connection && connectionMedia(connection.provider);
  if (!media) return undefined;
  const row = await deps.prisma.secret.findFirst({
    where: { id: connection.secretId, userId, spaceId: null },
  });
  if (!row) return undefined;
  const plaintext = await deps.secretStore.load(row.ciphertext, row.id);
  let secret: ReturnType<typeof parseModelSecret>;
  try {
    secret = parseModelSecret(plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unusable as a removed connection.
    getLogger().warn("media.connection_secret_unreadable", { "media.connection_id": connectionId });
    return undefined;
  }
  return secret.kind === "api_key"
    ? media.create({ apiKey: secret.key, zeroDataRetention: secret.zeroDataRetention, ...models })
    : undefined;
}

/** The provider that made, or will keep checking, a video job saved with this source. */
export function mediaVideoProviderForSource(
  deps: MediaSourceDeps,
  userId: string,
  source: MediaSourceRecord,
): Promise<MediaGenerationProvider | undefined> {
  return source.kind === "hosted"
    ? Promise.resolve(deps.mediaGeneration)
    : connectionProvider(deps, userId, source.connectionId, { videoModel: source.model });
}

/**
 * Where a run's images and videos come from: the model the owner chose for each, else the
 * newest connection that makes it, else the deployment's provider.
 */
export async function resolveRunMediaSources(
  deps: MediaSourceDeps,
  scope: { userId: string; spaceId: string },
): Promise<RunMediaSources> {
  const connections = await mediaConnections(deps.prisma, scope.userId);
  // A choice can only name a connection, so without one there is nothing to read.
  const [image, video] = connections.length
    ? await Promise.all([
        appliedModelRole(deps.prisma, scope, "image"),
        appliedModelRole(deps.prisma, scope, "video"),
      ])
    : [null, null];
  const hosted = deps.mediaGeneration;
  const source = (
    role: MediaModelRole,
    chosen: ModelRoleSettings | null,
  ): MediaSource | undefined => {
    const kind = ROLE_KIND[role];
    const fallback = hosted?.capabilities[kind] ? { record: HOSTED, provider: hosted } : undefined;
    const choice = mediaChoice(role, connections, chosen?.primary ?? null);
    if (!choice) return fallback && (() => Promise.resolve(fallback));
    const { connection, model } = choice;
    let own: Promise<MediaGenerationProvider | undefined> | undefined;
    return async () => {
      // A failed key lookup is not kept, so a later call in the same turn tries it again.
      own ??= connectionProvider(
        deps,
        scope.userId,
        connection.id,
        role === "image" ? { imageModel: model } : { videoModel: model },
      ).catch((error: unknown) => {
        own = undefined;
        throw error;
      });
      const provider = await own;
      // A connection removed or left unreadable since leaves the media to the deployment.
      return provider
        ? { record: { kind: "connection", connectionId: connection.id, model }, provider }
        : fallback;
    };
  };
  return { image: source("image", image), video: source("video", video) };
}
