import type { AgentToolResultContent } from "@rakazo/adapter-kit";
import { AttachmentValidationError, decodeAttachmentBase64 } from "@rakazo/core";
import { imageHeaderDimensions } from "../media/image-dimensions.js";
import { detectImageMimeType } from "../media/image-mime-type.js";
import { MCP_IMAGE_ATTACHED, MCP_IMAGE_NOT_ATTACHED } from "./mcp-result-images.prompt.js";

type ToolResultImage = Extract<AgentToolResultContent, { type: "image" }>;

/**
 * MCP tools return pictures as `{ type: "image", data, mimeType }` content parts. Serialized into
 * the result text, the base64 is unreadable to the model and the text limit cuts it apart. This
 * moves each image into its own part and leaves a short note where its data was. A result without
 * image parts comes back as it is.
 */
export function liftMcpResultImages(result: unknown): {
  result: unknown;
  images: ToolResultImage[];
} {
  const record = result as { content?: unknown } | null;
  if (!Array.isArray(record?.content) || !record.content.some(isImagePart))
    return { result, images: [] };
  const images: ToolResultImage[] = [];
  const content = record.content.map((part) => {
    if (!isImagePart(part)) return part;
    const image = toolResultImage(part.data);
    if (image) images.push(image);
    return { ...part, data: image ? MCP_IMAGE_ATTACHED : MCP_IMAGE_NOT_ATTACHED };
  });
  return { result: { ...record, content }, images };
}

function isImagePart(part: unknown): part is { type: "image"; data: string } {
  const { type, data } = (part ?? {}) as { type?: unknown; data?: unknown };
  return type === "image" && typeof data === "string";
}

/**
 * The bytes decide the format, not the server's label. Malformed base64 is dropped here because a
 * provider rejects the whole request for it, which would fail every later turn that carries it.
 */
function toolResultImage(data: string): ToolResultImage | undefined {
  const base64 = data.trim();
  let bytes: Uint8Array;
  try {
    bytes = decodeAttachmentBase64(base64);
  } catch (error) {
    if (error instanceof AttachmentValidationError) return undefined;
    throw error;
  }
  const mimeType = detectImageMimeType(bytes);
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return undefined;
  return isStillImage(base64, mimeType) ? { type: "image", data: base64, mimeType } : undefined;
}

/**
 * Only a single frame whose header gives a usable size: an unreadable header is budgeted by its
 * bytes, and a declared animation by its frame count, either of which the server can inflate past
 * the whole context window.
 */
function isStillImage(base64: string, mimeType: string): boolean {
  const dimensions = imageHeaderDimensions(base64, mimeType);
  if (!dimensions) return false;
  const [width, height, frames] = dimensions;
  return frames === 1 && Number.isSafeInteger(width * height);
}
