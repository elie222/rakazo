import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import {
  checkMediaModelId,
  mediaBaseUrl,
  mediaHttpError,
  requestImagesApiImage,
} from "../../../media/images-api.js";
import {
  mediaPromptSchema,
  UNKNOWN_MODEL_PRICES,
  validateGeneratedMedia,
} from "../../../media/media-generation-provider.js";
import type { ResolveHostname } from "../../../web/web-ssrf.js";
import { readBodyCapped } from "../../../web/web-ssrf.js";

const API = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 100_000;
export const VIDEO_SECONDS = 4;
/**
 * Per model, the most one image (auto size and quality) or one four-second video with its default
 * audio costs, from OpenRouter's published prices, in micro-dollars. Each response reports what
 * the generation actually cost, and that is what is charged.
 */
const IMAGE_MICROS = new Map([
  ["openai/gpt-image-2", 211_000],
  ["openai/gpt-image-1", 250_000],
  ["openai/gpt-image-1-mini", 52_000],
  ["google/gemini-2.5-flash-image", 40_000],
]);
const VIDEO_MICROS = new Map([
  ["google/veo-3.1-lite", 320_000],
  ["google/veo-3.1-fast", 480_000],
  ["google/veo-3.1", 1_600_000],
]);
const usageCost = z.object({ usage: z.object({ cost: z.number().nonnegative() }) });
const costMicros = (cost: number) => Math.round(cost * 1_000_000);
const JOB_ID_PATTERN = /^[\w-]{1,200}$/;
const videoJob = z.object({
  id: z.string().regex(JOB_ID_PATTERN),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "expired"]),
  progress: z.number().min(0).max(100).optional(),
});

type PendingJob = Exclude<MediaVideoJob, { status: "completed" }>;

/**
 * Images through `POST /images` (the Images API shape) and four-second videos through the
 * asynchronous `POST /videos` job API, downloaded from the job's own content endpoint.
 */
export class OpenRouterMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openrouter";
  readonly capabilities;
  readonly prices;
  private readonly baseUrl: string;
  constructor(
    private readonly options: {
      apiKey: string;
      imageModel?: string;
      videoModel?: string;
      /** Route only to endpoints that keep no prompts, as the connection asks. */
      zeroDataRetention?: boolean;
      baseUrl?: string;
      fetch?: typeof fetch;
      resolveHostname?: ResolveHostname;
    },
  ) {
    this.baseUrl = mediaBaseUrl(options.baseUrl ?? API);
    for (const model of [options.imageModel, options.videoModel])
      if (model) checkMediaModelId(model);
    this.capabilities = {
      images: Boolean(options.imageModel),
      video: Boolean(options.videoModel),
      offline: false,
    };
    this.prices = {
      imageMicros: IMAGE_MICROS.get(options.imageModel ?? "") ?? UNKNOWN_MODEL_PRICES.imageMicros,
      videoMicros: VIDEO_MICROS.get(options.videoModel ?? "") ?? UNKNOWN_MODEL_PRICES.videoMicros,
    };
  }
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia> {
    const model = this.options.imageModel;
    if (!model) return Promise.reject(new MediaGenerationError("unsupported"));
    return requestImagesApiImage(
      {
        ...this.options,
        endpoint: `${this.baseUrl}/images`,
        model,
        ...input,
        extraBody: this.routing(),
        costMicros: (usage) => (usage.cost === undefined ? undefined : costMicros(usage.cost)),
      },
      context,
    );
  }
  async generateVideo(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<MediaVideoJob> {
    const model = this.options.videoModel;
    if (!model) throw new MediaGenerationError("unsupported");
    const parsed = mediaPromptSchema.safeParse(input);
    if (!parsed.success) throw new MediaGenerationError("invalid_input");
    const job = this.job(
      await this.request("/videos", context, {
        ...this.routing(),
        model,
        prompt: parsed.data.prompt,
        duration: VIDEO_SECONDS,
      }),
    );
    // A job finished at submit is downloaded by the first poll.
    return job.status === "completed" ? { id: job.id, status: "running" } : job;
  }
  async pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob> {
    if (!JOB_ID_PATTERN.test(id)) throw new MediaGenerationError("invalid_input");
    const body = await this.request(`/videos/${id}`, context);
    const job = this.job(body);
    if (job.id !== id) throw new MediaGenerationError("provider_failure");
    if (job.status !== "completed") return job;
    const cost = usageCost.safeParse(body);
    const output = {
      bytes: await this.content(id, context),
      mimeType: "video/mp4",
      ...(cost.success ? { costMicros: costMicros(cost.data.usage.cost) } : {}),
    } as const;
    validateGeneratedMedia(output, "video");
    return { id, status: "completed", output };
  }
  private routing() {
    return this.options.zeroDataRetention ? { provider: { zdr: true } } : {};
  }
  private job(body: unknown): PendingJob | { id: string; status: "completed" } {
    const parsed = videoJob.safeParse(body);
    if (!parsed.success) throw new MediaGenerationError("provider_failure");
    const { id, status, progress } = parsed.data;
    if (status === "pending" || status === "in_progress")
      return {
        id,
        status: status === "pending" ? "queued" : "running",
        ...(progress === undefined ? {} : { progress }),
      };
    if (status === "completed") return { id, status };
    return { id, status: "failed" };
  }
  private async request(path: string, context: AdapterContext, body?: unknown): Promise<unknown> {
    const signal = deadlineSignal(REQUEST_TIMEOUT_MS, context.signal);
    const response = await this.fetch(path, context, signal, body);
    return this.read(context, () =>
      readBodyCapped(response, MAX_JSON_BYTES, signal).then((bytes) =>
        JSON.parse(new TextDecoder().decode(bytes)),
      ),
    );
  }
  /** The finished video's bytes from OpenRouter itself, so the key never leaves its host. */
  private async content(id: string, context: AdapterContext): Promise<Uint8Array> {
    const signal = deadlineSignal(DOWNLOAD_TIMEOUT_MS, context.signal);
    const response = await this.fetch(`/videos/${id}/content?index=0`, context, signal);
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "video/mp4") {
      // Not awaited: a cancel that never settles must not hold the error back.
      void bestEffort("cancel media response", response.body?.cancel());
      throw new MediaGenerationError("provider_failure");
    }
    return this.read(context, () => readBodyCapped(response, ATTACHMENT_MAX_BYTES, signal));
  }
  private async fetch(
    path: string,
    context: AdapterContext,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    context.signal.throwIfAborted();
    return this.read(context, async () => {
      const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        // Not awaited: a cancel that never settles must not hold the error back.
        void bestEffort("cancel media response", response.body?.cancel());
        throw mediaHttpError(response.status);
      }
      return response;
    });
  }
  /** Keeps cancellation, and turns every other failure into a sanitized media error. */
  private async read<T>(context: AdapterContext, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof MediaGenerationError) throw error;
      throw new MediaGenerationError(
        error instanceof ResponseTooLargeError ? "output_limit" : "provider_failure",
      );
    }
  }
}
