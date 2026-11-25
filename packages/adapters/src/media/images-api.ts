import type { AdapterContext, GeneratedMedia } from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import type { ResolveHostname } from "../web/web-ssrf.js";
import { fetchSafeWebBytes, readBodyCapped } from "../web/web-ssrf.js";
import { detectImageMimeType } from "./image-mime-type.js";
import {
  GENERATED_IMAGE_MIME_TYPES,
  mediaPromptSchema,
  validateGeneratedMedia,
} from "./media-generation-provider.js";

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
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
});
export type ImagesApiUsage = NonNullable<z.infer<typeof imagesResponse>["usage"]>;

/** The base URL without a trailing slash, refusing credentials, queries and fragments. */
export function mediaBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid media generation base URL");
  return url.href.replace(/\/$/, "");
}

export const isMediaModelId = (model: string) => MODEL_ID_PATTERN.test(model);

export function checkMediaModelId(model: string) {
  if (!isMediaModelId(model)) throw new Error("Invalid media model id");
}

export function mediaHttpError(status: number): MediaGenerationError {
  return new MediaGenerationError(
    status === 429
      ? "rate_limit"
      : [401, 403].includes(status)
        ? "authentication"
        : "provider_failure",
  );
}

/**
 * One image from an Images API style endpoint: a JSON POST answered with `data[0]` holding the
 * image inline (`b64_json`) or as a link, which is downloaded like any untrusted output URL.
 */
export async function requestImagesApiImage(
  options: {
    endpoint: string;
    apiKey: string;
    model: string;
    prompt: string;
    /** Extra request fields the provider's own API takes, such as its routing preferences. */
    extraBody?: Record<string, unknown>;
    fetch?: typeof fetch;
    resolveHostname?: ResolveHostname;
    /** What the response's usage says the image cost, in micro-dollars, if it says. */
    costMicros?: (usage: ImagesApiUsage) => number | undefined;
  },
  context: AdapterContext,
): Promise<GeneratedMedia> {
  const parsed = mediaPromptSchema.safeParse({ prompt: options.prompt });
  if (!parsed.success) throw new MediaGenerationError("invalid_input");
  context.signal.throwIfAborted();
  const signal = deadlineSignal(IMAGE_DEADLINE_MS, context.signal);
  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...options.extraBody,
        model: options.model,
        prompt: parsed.data.prompt,
        n: 1,
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      // Not awaited: a cancel that never settles must not hold the error back.
      void bestEffort("cancel media response", response.body?.cancel());
      throw mediaHttpError(response.status);
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
      : await download(item.url, options, context, signal);
  // The format is read from the bytes: servers differ in what they return and how they label it.
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType || !GENERATED_IMAGE_MIME_TYPES.has(mimeType))
    throw new MediaGenerationError("provider_failure");
  const usage = result.data.usage;
  const costMicros = usage && options.costMicros?.(usage);
  const output = {
    bytes,
    mimeType,
    ...(costMicros === undefined ? {} : { costMicros }),
  } as GeneratedMedia;
  validateGeneratedMedia(output, "image");
  return output;
}

async function download(
  url: string,
  options: { fetch?: typeof fetch; resolveHostname?: ResolveHostname },
  context: AdapterContext,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    // Output URLs are untrusted. Pin public DNS, reject private addresses and redirects;
    // no API credential is ever sent to the output host.
    const result = await fetchSafeWebBytes(url, {
      fetch: options.fetch,
      resolveHostname: options.resolveHostname,
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

function decodeImage(raw: string): Uint8Array {
  // Some servers wrap base64 lines.
  const encoded = raw.replace(/\s/g, "");
  if (encoded.length > ATTACHMENT_MAX_BASE64_LENGTH) throw new MediaGenerationError("output_limit");
  // Buffer.from skips characters that are not base64, so damaged data would decode short.
  if (!encoded || encoded.length % 4 || !BASE64_PATTERN.test(encoded))
    throw new MediaGenerationError("provider_failure");
  return new Uint8Array(Buffer.from(encoded, "base64"));
}
