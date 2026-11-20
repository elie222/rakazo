import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BASE64_LENGTH } from "@rakazo/contracts";
import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { z } from "zod";
import { detectImageMimeType } from "../../../media/image-mime-type.js";
import {
  GENERATED_IMAGE_MIME_TYPES,
  mediaPromptSchema,
  validateGeneratedMedia,
} from "../../../media/media-generation-provider.js";
import { readBodyCapped } from "../../../web/web-ssrf.js";

const API = "https://api.openai.com/v1";
const IMAGE_DEADLINE_MS = 180_000;
/** One base64 image at the attachment limit, plus room for the JSON around it. */
const MAX_RESPONSE_BYTES = ATTACHMENT_MAX_BASE64_LENGTH + 64 * 1024;
const MODEL_ID_PATTERN = /^[\w.:/@+-]{1,200}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const imagesResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});

/**
 * The Images API (`POST /images/generations`). Servers that speak the same API work through the
 * base URL. It returns the image inline, so there is no output URL to fetch; it has no video.
 */
export class OpenAIMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openai";
  readonly capabilities = { images: true, video: false, offline: false };
  private readonly endpoint: string;
  constructor(
    private readonly options: {
      apiKey: string;
      imageModel: string;
      baseUrl?: string;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.baseUrl ?? API);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid media generation base URL");
    if (!MODEL_ID_PATTERN.test(options.imageModel)) throw new Error("Invalid media model id");
    this.endpoint = `${url.href.replace(/\/$/, "")}/images/generations`;
  }
  async generateImage(
    input: MediaGenerationInput,
    context: AdapterContext,
  ): Promise<GeneratedMedia> {
    const parsed = mediaPromptSchema.safeParse(input);
    if (!parsed.success) throw new MediaGenerationError("invalid_input");
    context.signal.throwIfAborted();
    const signal = deadlineSignal(IMAGE_DEADLINE_MS, context.signal);
    let body: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.options.imageModel, prompt: parsed.data.prompt, n: 1 }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new MediaGenerationError(
          response.status === 429
            ? "rate_limit"
            : [401, 403].includes(response.status)
              ? "authentication"
              : "provider_failure",
        );
      }
      body = JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, MAX_RESPONSE_BYTES, signal)),
      );
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof MediaGenerationError) throw error;
      throw new MediaGenerationError(
        error instanceof ResponseTooLargeError ? "output_limit" : "provider_failure",
      );
    }
    const result = imagesResponse.safeParse(body);
    if (!result.success) throw new MediaGenerationError("provider_failure");
    const encoded = result.data.data[0]!.b64_json;
    if (encoded.length > ATTACHMENT_MAX_BASE64_LENGTH)
      throw new MediaGenerationError("output_limit");
    // Buffer.from skips characters that are not base64, so damaged data would decode short.
    if (encoded.length % 4 || !BASE64_PATTERN.test(encoded))
      throw new MediaGenerationError("provider_failure");
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    // The format is read from the bytes: servers differ in what they return and how they label it.
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType || !GENERATED_IMAGE_MIME_TYPES.has(mimeType))
      throw new MediaGenerationError("provider_failure");
    const output = { bytes, mimeType } as GeneratedMedia;
    validateGeneratedMedia(output, "image");
    return output;
  }
  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
}
