import type { AgentToolExecutionResult, AgentToolResultContent } from "@rakazo/adapter-kit";
import type { AttachmentImageMimeType } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { detectImageMimeType } from "./image-mime-type.js";
import { IMAGE_MODEL_CANNOT_SEE, IMAGE_UNREADABLE } from "./tool-result-image.prompt.js";

/** Largest picture a tool reads to show the model. */
export const TOOL_IMAGE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
/** Longest edge sent to the model; larger pictures are scaled down to fit. */
export const TOOL_IMAGE_MAX_EDGE = 1568;
/**
 * Base64 size ceiling for images sent inline to model providers (5 MiB covers strict
 * direct provider APIs as well as 10 MB proxies).
 */
export const MODEL_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;
/** Largest raw image byte length whose base64 encoding fits within MODEL_IMAGE_MAX_BASE64_BYTES. */
export const MODEL_IMAGE_MAX_RAW_BYTES = Math.floor(MODEL_IMAGE_MAX_BASE64_BYTES / 4) * 3;
/** Above this size a lossless copy is re-encoded as JPEG. */
const PNG_OUTPUT_MAX_BYTES = 1_500_000;
const JPEG_FALLBACK_QUALITIES = [85, 70, 55, 40] as const;
// Refuse decompression bombs before their pixels are decoded.
const MAX_INPUT_PIXELS = 50_000_000;

/** Tools whose pictures are files or pages the bot read, not screenshots to keep with the reply. */
export const PICTURE_READING_TOOLS = new Set(["read_file", "web_fetch"]);

type ToolResultImage = Extract<AgentToolResultContent, { type: "image" }>;

/** Whether these bytes are a picture a tool can show the model (PNG, JPEG, GIF or WebP). */
export function isToolImage(bytes: Uint8Array): boolean {
  return detectImageMimeType(bytes) !== undefined;
}

/**
 * A tool result that hands the model the picture itself, scaled to fit and re-encoded as PNG or
 * JPEG, with `details` as its text. A model that takes text only gets a short note instead, and
 * only `details` (never the pixels) is what callers store.
 */
export async function imageToolResult(
  bytes: Uint8Array,
  details: Record<string, unknown>,
  modelSeesImages: boolean,
): Promise<AgentToolExecutionResult | ({ error: string } & Record<string, unknown>)> {
  const format = detectImageMimeType(bytes);
  if (!format) return { ...details, error: IMAGE_UNREADABLE };
  if (!modelSeesImages) return { ...details, mimeType: format, error: IMAGE_MODEL_CANNOT_SEE };
  const image = await encodeForModel(bytes, format);
  if (!image) return { ...details, mimeType: format, error: IMAGE_UNREADABLE };
  const described = {
    ...details,
    mimeType: format,
    width: image.width,
    height: image.height,
    ...(image.scaled ? { scaledTo: `${image.sentWidth}x${image.sentHeight}` } : {}),
  };
  return {
    kind: "agent_tool_result",
    content: [
      { type: "text", text: JSON.stringify(described) },
      { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
    ],
    details: described,
  };
}

/**
 * Prepare a stored image attachment or screenshot for a model turn. Images that already fit
 * within MODEL_IMAGE_MAX_BASE64_BYTES pass through unchanged (with magic-byte MIME detection);
 * larger images are scaled and re-encoded through encodeForModel, and an oversized image that
 * cannot be decoded is omitted rather than sent raw to fail the turn.
 */
export async function prepareImageForModel(
  bytes: Uint8Array,
  declaredMimeType: AttachmentImageMimeType,
): Promise<{ data: Uint8Array; mimeType: AttachmentImageMimeType } | undefined> {
  const format = detectImageMimeType(bytes);
  if (bytes.byteLength <= MODEL_IMAGE_MAX_RAW_BYTES) {
    return { data: bytes, mimeType: format ?? declaredMimeType };
  }
  if (!format) {
    getLogger().warn("model_image.oversized_unrecognized", {
      "image.bytes": bytes.byteLength,
      "image.declared_mime_type": declaredMimeType,
    });
    return undefined;
  }
  const encoded = await encodeForModel(bytes, format);
  if (!encoded) return undefined;
  return { data: encoded.data, mimeType: encoded.mimeType };
}

async function encodeForModel(
  bytes: Uint8Array,
  format: string,
): Promise<
  | {
      data: Buffer;
      mimeType: ToolResultImage["mimeType"];
      width: number;
      height: number;
      sentWidth: number;
      sentHeight: number;
      scaled: boolean;
    }
  | undefined
> {
  try {
    // sharp is a native addon; load it inside the try so a missing binary degrades cleanly.
    const { default: sharp } = await import("sharp");
    // An animation is shown by its first frame.
    const source = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate();
    const metadata = await source.metadata();
    // EXIF orientations 5 to 8 swap the stored width and height.
    const swapped = (metadata.orientation ?? 1) >= 5;
    const width = (swapped ? metadata.height : metadata.width) ?? 0;
    const height = (swapped ? metadata.width : metadata.height) ?? 0;
    if (width < 1 || height < 1) return undefined;
    const resized = source.resize(TOOL_IMAGE_MAX_EDGE, TOOL_IMAGE_MAX_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
    });
    let output: { data: Buffer; info: { width: number; height: number } } | undefined;
    let mimeType: ToolResultImage["mimeType"] = "image/png";
    if (format === "image/png" || metadata.hasAlpha) {
      output = await resized.clone().png().toBuffer({ resolveWithObject: true });
      if (output.data.byteLength > PNG_OUTPUT_MAX_BYTES) output = undefined;
    }
    if (!output) {
      mimeType = "image/jpeg";
      for (const quality of JPEG_FALLBACK_QUALITIES) {
        const candidate = await resized
          .clone()
          .flatten({ background: "#ffffff" })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true });
        if (candidate.data.byteLength <= MODEL_IMAGE_MAX_RAW_BYTES) {
          output = candidate;
          break;
        }
      }
      if (!output) return undefined;
    }
    return {
      data: output.data,
      mimeType,
      width,
      height,
      sentWidth: output.info.width,
      sentHeight: output.info.height,
      scaled: output.info.width !== width || output.info.height !== height,
    };
  } catch (error) {
    // Truncated, corrupt or over the pixel limit. Logged so a broken decoder shows as one.
    getLogger().warn("tool_image.decode_failed", { error, "image.format": format });
    return undefined;
  }
}
