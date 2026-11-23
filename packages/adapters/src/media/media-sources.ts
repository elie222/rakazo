import type { MediaGenerationProvider, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  JsonColumnMismatchError,
  newestModelCredentialOrder,
  readJsonColumn,
  reportJsonColumnOnce,
} from "@rakazo/db";
import { z } from "zod";
import {
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../models/model-provider-allowlist.js";
import type { ModelProviderDefinition } from "../models/model-provider-registry.js";
import { modelProviderDefinition, modelProviders } from "../models/model-provider-registry.js";
import { parseModelSecret } from "../models/model-secret.js";

/**
 * What made a generation, saved on its job: the run owner's own model connection, which costs
 * them nothing on Rakazo's side, or the deployment's hosted provider, which metering charges.
 */
export const mediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connection"), connectionId: z.string().min(1) }),
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
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">;
  secretStore: Pick<SecretStore, "load">;
  /** The deployment-wide provider, used when the owner has no connection that makes the media. */
  mediaGeneration?: MediaGenerationProvider;
}

type ConnectionMedia = NonNullable<ModelProviderDefinition["media"]>;

function connectionMedia(provider: string): ConnectionMedia | undefined {
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) return undefined;
  return modelProviderDefinition(provider)?.media;
}

const mediaProviderIds = () => Object.keys(modelProviders).filter((id) => connectionMedia(id));

/** Builds the connection's media provider from its stored key; undefined once it is gone. */
async function connectionProvider(
  deps: MediaSourceDeps,
  userId: string,
  connectionId: string,
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
    return undefined;
  }
  return secret.kind === "api_key" ? media.create({ apiKey: secret.key }) : undefined;
}

/** The provider that made, or will keep checking, a job saved with this source. */
export function mediaProviderForSource(
  deps: MediaSourceDeps,
  userId: string,
  source: MediaSourceRecord,
): Promise<MediaGenerationProvider | undefined> {
  return source.kind === "hosted"
    ? Promise.resolve(deps.mediaGeneration)
    : connectionProvider(deps, userId, source.connectionId);
}

/**
 * Where a run's images and videos come from: the owner's newest connection whose provider
 * declares that media, otherwise the deployment's provider.
 */
export async function resolveRunMediaSources(
  deps: MediaSourceDeps,
  userId: string,
): Promise<RunMediaSources> {
  const connection = await deps.prisma.userModelCredential.findFirst({
    where: { userId, provider: { in: mediaProviderIds() } },
    orderBy: newestModelCredentialOrder,
    select: { id: true, provider: true },
  });
  const media = connection && connectionMedia(connection.provider);
  const hosted = deps.mediaGeneration;
  let own: Promise<MediaGenerationProvider | undefined> | undefined;
  const source = (kind: "images" | "video"): MediaSource | undefined => {
    const fallback = hosted?.capabilities[kind] ? { record: HOSTED, provider: hosted } : undefined;
    if (!connection || !media?.[kind]) return fallback && (() => Promise.resolve(fallback));
    return async () => {
      own ??= connectionProvider(deps, userId, connection.id);
      const provider = await own;
      // A connection removed or left unreadable since leaves the media to the deployment.
      return provider
        ? { record: { kind: "connection", connectionId: connection.id }, provider }
        : fallback;
    };
  };
  return { image: source("images"), video: source("video") };
}
