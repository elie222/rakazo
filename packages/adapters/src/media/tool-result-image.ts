import type { AgentToolExecutionResult, AgentToolResultContent } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { detectImageMimeType } from "./image-mime-type.js";
import { IMAGE_MODEL_CANNOT_SEE, IMAGE_UNREADABLE } from "./tool-result-image.prompt.js";

/** Largest picture a tool reads to show the model. */
export const TOOL_IMAGE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
/** Longest edge sent to the model; larger pictures are scaled down to fit. */
export const TOOL_IMAGE_MAX_EDGE = 1568;
/** Above this size a lossless copy is re-encoded as JPEG. */
const PNG_OUTPUT_MAX_BYTES = 1_500_000;
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
    content: [{ type: "text", text: JSON.stringify(described) }, image.content],
    details: described,
  };
}

async function encodeForModel(
  bytes: Uint8Array,
  format: string,
): Promise<
  | {
      content: ToolResultImage;
      width: number;
      height: number;
      sentWidth: number;
      sentHeight: number;
      scaled: boolean;
    }
  | undefined
> {
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  try {
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
      output = await resized
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
    }
    return {
      content: { type: "image", data: output.data.toString("base64"), mimeType },
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
