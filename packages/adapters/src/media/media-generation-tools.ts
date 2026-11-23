import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { messageBlockForArtifact } from "@rakazo/core";
import type { ExternalEffect, Prisma, PrismaClient } from "@rakazo/db";
import { isUniqueViolation, readJsonColumn } from "@rakazo/db";
import { z } from "zod";
import { mediaPromptSchema, validateGeneratedMedia } from "./media-generation-provider.js";
import type { MediaSourceRecord } from "./media-sources.js";
import type { OwnKeyMediaSpend } from "./media-spend.js";
import type { MediaCharge } from "./media-usage.js";

export const MEDIA_JOB_KIND = "media_generation_job";
export const MEDIA_UNAVAILABLE = "Media generation is unavailable.";
export const VIDEO_JOB_UNAVAILABLE = "Video job is unavailable.";
const FILE_EXTENSIONS: Record<GeneratedMedia["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};
const savedJob = z.object({
  provider: z.string(),
  jobId: z.string().optional(),
  artifactId: z.string().optional(),
});
const savedCharge = z.object({
  charge: z.object({ organizationId: z.string(), micros: z.number().int().positive() }).optional(),
});

/** A finished hosted generation's charge, committed with its stored output. */
export type StoredMediaCharge = { organizationId: string; kind: string; amountMicros: number };

/** The price a generation saved when it was submitted; none where nothing is metered. */
export function savedMediaCharge(effect: Pick<ExternalEffect, "id" | "request">) {
  return readJsonColumn(
    savedCharge,
    effect.request,
    { table: "external_effects", column: "request", id: effect.id },
    "reject",
  ).charge;
}

export async function generateMediaFromTool(options: {
  name: "generate_image" | "generate_video";
  args: Record<string, unknown>;
  executionId: string;
  /** Recover only persisted state; never submit a new billed generation. */
  recoverOnly?: boolean;
  provider: MediaGenerationProvider;
  /** Saved with a new job, so later checks rebuild its provider and metering knows who paid. */
  source: MediaSourceRecord;
  prisma: PrismaClient;
  context: AdapterContext;
  run: { id: string; threadId: string; botId: string; userId: string; spaceId: string };
  /** Saved with a new job so background delivery skips a chat that was cleared since. */
  threadGeneration?: number;
  attach: (
    output: GeneratedMedia,
    name: string,
    job: {
      id: string;
      result: { provider: string; jobId?: string };
      charge?: StoredMediaCharge;
      spend?: OwnKeyMediaSpend;
    },
  ) => Promise<{ artifactId: string; block: MessageBlock }>;
  publish: (block: MessageBlock, jobId: string, artifactId: string) => Promise<unknown>;
  /** Commits with a video's provider failure, so whatever follows it cannot be lost. */
  onSettled?: (tx: Prisma.TransactionClient, status: "failed") => Promise<void>;
  /** Prices a new submission, or refuses it; without one nothing is charged. */
  price?: (kind: "image" | "video") => Promise<{ charge: MediaCharge | null } | { error: string }>;
}) {
  const { provider, prisma, context, run, args } = options;
  const video = options.name === "generate_video";
  if (!(video ? provider.capabilities.video : provider.capabilities.images))
    return { error: MEDIA_UNAVAILABLE };
  try {
    if (
      args.jobId !== undefined &&
      (!video ||
        typeof args.jobId !== "string" ||
        !args.jobId ||
        args.jobId.length > 200 ||
        args.prompt !== undefined)
    ) {
      return { error: "Use a prompt to submit or jobId alone to poll a video." };
    }
    let reservation: ExternalEffect | null = null;
    let polling = false;
    if (video && typeof args.jobId === "string") {
      reservation = await prisma.externalEffect.findFirst({
        where: {
          id: args.jobId,
          kind: MEDIA_JOB_KIND,
          spaceId: run.spaceId,
          run: { userId: run.userId, botId: run.botId, threadId: run.threadId },
        },
      });
      if (!reservation) return { error: VIDEO_JOB_UNAVAILABLE };
      const saved = savedJob.safeParse(reservation.result);
      if (!saved.success || saved.data.provider !== provider.id)
        return {
          error:
            "Video job provider changed or submission is uncertain. Do not resubmit automatically.",
        };
      if (saved.data.artifactId && reservation.status === "media_completed")
        return { status: "completed", artifactId: saved.data.artifactId };
      if (reservation.status === "media_failed") return { status: "failed" };
      if (!saved.data.jobId && !saved.data.artifactId)
        return { error: "Submission is uncertain. Do not resubmit automatically." };
    } else {
      const prior = await prisma.externalEffect.findFirst({
        where: {
          runId: run.id,
          kind: MEDIA_JOB_KIND,
          request: { path: ["executionId"], equals: options.executionId },
        },
      });
      if (prior) {
        const saved = savedJob.safeParse(prior.result);
        if (saved.success && saved.data.artifactId) {
          if (prior.status === "media_completed")
            return { status: "completed", artifactId: saved.data.artifactId };
          reservation = prior;
        } else {
          if (video && saved.success && saved.data.jobId)
            return {
              jobId: prior.id,
              status: prior.status === "media_failed" ? "failed" : "queued",
            };
          if (options.recoverOnly) return undefined;
          return {
            jobId: prior.id,
            error: "Submission already attempted. Poll a video job; do not resubmit automatically.",
          };
        }
      }
      if (!reservation) {
        if (options.recoverOnly) return undefined;
        const input = mediaPromptSchema.safeParse(args);
        if (!input.success) return { error: "A prompt of 1–4000 characters is required." };
        const priced = options.price
          ? await options.price(video ? "video" : "image")
          : { charge: null };
        if ("error" in priced) return { error: priced.error };
        // A unique slot makes the per-run cap durable even across concurrent calls/restarts.
        for (let slot = 0; slot < 2; slot++) {
          try {
            reservation = await prisma.externalEffect.create({
              data: {
                spaceId: run.spaceId,
                runId: run.id,
                kind: MEDIA_JOB_KIND,
                idempotencyKey: `media:${run.id}:${slot}`,
                status: "media_submitting",
                request: {
                  tool: options.name,
                  prompt: input.data.prompt,
                  executionId: options.executionId,
                  ...(priced.charge ? { charge: priced.charge } : {}),
                  mediaSource: options.source,
                  ...(options.threadGeneration === undefined
                    ? {}
                    : { threadGeneration: options.threadGeneration }),
                },
                result: { provider: provider.id },
              },
            });
            break;
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
          }
        }
        if (!reservation)
          return { error: "Media generation limit reached (two submissions per run)." };
      }
    }
    const saved = savedJob.parse(reservation.result);
    if (saved.artifactId) {
      const artifact = await prisma.artifact.findFirst({
        where: { id: saved.artifactId, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
      });
      if (!artifact) return { error: "Generated attachment is unavailable." };
      await options.publish(messageBlockForArtifact(artifact), reservation.id, artifact.id);
      return { status: "completed", artifactId: artifact.id };
    }
    // Read before the provider is asked, so a request that cannot be read discards no output.
    const charge = savedMediaCharge(reservation);
    if (video && typeof args.jobId === "string") {
      const claim = await prisma.externalEffect.updateMany({
        where: {
          id: reservation.id,
          OR: [
            { status: "media_pending" },
            { status: "media_polling", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        data: { status: "media_polling" },
      });
      if (!claim.count)
        return options.recoverOnly
          ? { jobId: reservation.id, status: "running" }
          : {
              error:
                "Video job is already being checked or needs recovery. Do not resubmit automatically.",
            };
      polling = true;
    }
    let output: MediaVideoJob | { status: "completed"; output: GeneratedMedia };
    try {
      output = video
        ? saved.jobId
          ? await provider.pollVideo(saved.jobId, context)
          : await provider.generateVideo(mediaPromptSchema.parse(args), context)
        : {
            status: "completed" as const,
            output: await provider.generateImage(mediaPromptSchema.parse(args), context),
          };
    } catch (error) {
      // Release only this check's claim; a finished or failed job stays settled.
      if (polling)
        await prisma.externalEffect.updateMany({
          where: { id: reservation.id, status: "media_polling" },
          data: { status: "media_pending" },
        });
      throw error;
    }
    if (video && "id" in output) {
      const settle = async (tx: Prisma.TransactionClient) => {
        const updated = await tx.externalEffect.updateMany({
          where: {
            id: reservation.id,
            status: polling ? "media_polling" : "media_submitting",
            result: { equals: saved },
          },
          data: {
            status:
              output.status === "failed"
                ? "media_failed"
                : output.status === "completed"
                  ? "media_polling"
                  : "media_pending",
            result: { provider: provider.id, jobId: output.id },
          },
        });
        if (updated.count && output.status === "failed") await options.onSettled?.(tx, "failed");
      };
      if (output.status === "failed" && options.onSettled) await prisma.$transaction(settle);
      else await settle(prisma);
    }
    if (output.status !== "completed")
      return {
        jobId: reservation.id,
        status: output.status,
        ...("progress" in output ? { progress: output.progress } : {}),
      };
    const fetched = {
      provider: provider.id,
      ...("id" in output ? { jobId: output.id } : {}),
    };
    let attached: { artifactId: string; block: MessageBlock };
    try {
      validateGeneratedMedia(output.output, video ? "video" : "image");
      context.signal.throwIfAborted();
      attached = await options.attach(
        output.output,
        `generated-${reservation.id}.${FILE_EXTENSIONS[output.output.mimeType]}`,
        {
          id: reservation.id,
          result: fetched,
          // Charged with the stored output: what the provider reported it cost, else the saved price.
          ...(charge
            ? {
                charge: {
                  organizationId: charge.organizationId,
                  kind: video ? "video" : "image",
                  amountMicros: output.output.costMicros ?? charge.micros,
                },
              }
            : {}),
          // compat-shim(after v0.15.0): a job the previous release saved names no model to record.
          ...(options.source.kind === "connection" && options.source.model
            ? {
                spend: {
                  role: video ? "video" : "image",
                  provider: provider.id,
                  model: options.source.model,
                  // A response that says nothing of cost is counted at the model's saved price.
                  costMicros:
                    output.output.costMicros ??
                    provider.prices[video ? "videoMicros" : "imageMicros"],
                  estimated: output.output.costMicros === undefined,
                },
              }
            : {}),
        },
      );
    } catch (error) {
      // A finished video that could not be stored releases its claim, so a later check retries
      // it and the deadline can still report it failed.
      if (video && "id" in output)
        await prisma.externalEffect.updateMany({
          where: { id: reservation.id, status: "media_polling", result: { equals: fetched } },
          data: { status: "media_pending" },
        });
      throw error;
    }
    await options.publish(attached.block, reservation.id, attached.artifactId);
    return { status: "completed", artifactId: attached.artifactId };
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error:
        error instanceof MediaGenerationError
          ? error.message
          : "Media generation failed. Submission may have been accepted; do not retry automatically.",
    };
  }
}
