import { createHash } from "node:crypto";
import { ATTACHMENT_IMAGE_MAX_EDGE, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { detectImageMimeType } from "../media/image-mime-type.js";
import type { SafeWebFetchOptions } from "../web/web-ssrf.js";
import { fetchSafeWebBytes } from "../web/web-ssrf.js";

export const PAGE_IMAGE_SOURCE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
const MAX_INPUT_PIXELS = 50_000_000;
const WEBP_QUALITY = 80;

export type EncodedPageImage = {
  mimeType: "image/webp";
  width: number;
  height: number;
  data: string;
  hash: string;
};

export async function encodePageImage(bytes: Uint8Array): Promise<EncodedPageImage | string> {
  if (bytes.byteLength > PAGE_IMAGE_SOURCE_MAX_BYTES) return "the picture is larger than 10 MB";
  if (!detectImageMimeType(bytes)) return "only PNG, JPEG, GIF or WebP pictures can be shown";
  const { default: sharp } = await import("sharp");
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
    })
      .rotate()
      .resize(ATTACHMENT_IMAGE_MAX_EDGE, ATTACHMENT_IMAGE_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      mimeType: "image/webp",
      width: info.width,
      height: info.height,
      data: data.toString("base64"),
      hash: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    getLogger().warn("page_image.decode_failed", { error });
    return "the picture could not be read";
  }
}

export async function fetchPageImage(
  url: string,
  options: Pick<SafeWebFetchOptions, "fetch" | "resolveHostname" | "signal"> = {},
): Promise<Uint8Array | string> {
  try {
    const { body } = await fetchSafeWebBytes(url, {
      ...options,
      timeoutMs: 15_000,
      maxRedirects: 5,
      maxBytes: PAGE_IMAGE_SOURCE_MAX_BYTES,
      allowedPorts: [80, 443],
      headers: { accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9,image/*;q=0.5" },
    });
    return body;
  } catch (error) {
    return error instanceof Error ? error.message : "the address could not be read";
  }
}
