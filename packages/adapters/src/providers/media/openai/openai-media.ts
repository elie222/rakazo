import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { z } from "zod";
import { detectImageMimeType } from "../../../media/image-mime-type.js";
import {
  GENERATED_IMAGE_MIME_TYPES,
  mediaPromptSchema,
  validateGeneratedMedia,
} from "../../../media/media-generation-provider.js";
import type { ResolveHostname } from "../../../web/web-ssrf.js";
import { fetchSafeWebBytes, readBodyCapped } from "../../../web/web-ssrf.js";

const API = "https://api.openai.com/v1";
const IMAGE_DEADLINE_MS = 180_000;
/**
 * One base64 image at the attachment limit, allowing a CRLF after every 64 characters (servers
 * wrap lines and JSON escapes each break to four bytes; the decoded size is the real limit), plus room for the JSON around it.
 */
const MAX_RESPONSE_BYTES = Math.ceil(ATTACHMENT_MAX_BASE64_LENGTH * (1 + 4 / 64)) + 64 * 1024;
const MODEL_ID_PATTERN = /^[\w.:/@+-]{1,200}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const imagesResponse = z.object({
  data: z
    .array(
      z.union([z.object({ b64_json: z.string().min(1) }), z.object({ url: z.string().min(1) })]),
    )
    .min(1),
});

/**
 * The Images API (`POST /images/generations`). Servers that speak the same API work through the
 * base URL. It returns the image inline or as a link, which is downloaded like any untrusted output URL; it has no video.
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
      resolveHostname?: ResolveHostname;
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
    const item = result.data.data[0]!;
    const bytes =
      "b64_json" in item
        ? decodeImage(item.b64_json)
        : await this.download(item.url, context, signal);
    // The format is read from the bytes: servers differ in what they return and how they label it.
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType || !GENERATED_IMAGE_MIME_TYPES.has(mimeType))
      throw new MediaGenerationError("provider_failure");
    const output = { bytes, mimeType } as GeneratedMedia;
    validateGeneratedMedia(output, "image");
    return output;
  }
  private async download(
    url: string,
    context: AdapterContext,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      // Output URLs are untrusted. Pin public DNS, reject private addresses and redirects;
      // no API credential is ever sent to the output host.
      const result = await fetchSafeWebBytes(url, {
        fetch: this.options.fetch,
        resolveHostname: this.options.resolveHostname,
        signal,
        maxBytes: ATTACHMENT_MAX_BYTES,
        maxRedirects: 0,
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
      });
      return result.body;
    } catch (error) {
      context.signal.throwIfAborted();
      throw new MediaGenerationError(
        error instanceof ResponseTooLargeError ? "output_limit" : "provider_failure",
      );
    }
  }
  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
}

function decodeImage(raw: string): Uint8Array {
  // Some servers wrap base64 lines.
  const encoded = raw.replace(/\s/g, "");
  if (encoded.length > ATTACHMENT_MAX_BASE64_LENGTH) throw new MediaGenerationError("output_limit");
  // Buffer.from skips characters that are not base64, so damaged data would decode short.
  if (!encoded || encoded.length % 4 || !BASE64_PATTERN.test(encoded))
    throw new MediaGenerationError("provider_failure");
  return new Uint8Array(Buffer.from(encoded, "base64"));
}
