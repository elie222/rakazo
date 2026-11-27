import type { MessageBlock } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { isInlineImageMimeType } from "../messages/inline-image";

export type ArtifactGalleryItem = {
  id: string;
  name: string;
  mimeType: string;
};

export type ImageArtifactPreviewTarget = Pick<
  Extract<MessageBlock, { kind: "image" }>,
  "artifactId" | "name" | "mimeType"
>;

export function isMediaArtifact(item: Pick<ArtifactGalleryItem, "mimeType">): boolean {
  const kind = artifactPreviewKind(item.mimeType);
  return kind === "image" || kind === "video";
}

/** Image and video artifacts from a list page, in list order, without duplicate families. */
export function mediaArtifactGallery(
  items: readonly Pick<ArtifactGalleryItem, "id" | "name" | "mimeType">[],
): ArtifactGalleryItem[] {
  const seen = new Set<string>();
  const gallery: ArtifactGalleryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id) || !isMediaArtifact(item)) continue;
    seen.add(item.id);
    gallery.push({ id: item.id, name: item.name, mimeType: item.mimeType });
  }
  return gallery;
}

function parseGalleryItems(value: string | string[] | undefined): ArtifactGalleryItem[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: ArtifactGalleryItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, mimeType } = entry as Record<string, unknown>;
    if (typeof id === "string" && id && typeof name === "string" && typeof mimeType === "string") {
      items.push({ id, name, mimeType });
    }
  }
  return items;
}

export function parseArtifactGallery(value: string | string[] | undefined): ArtifactGalleryItem[] {
  return mediaArtifactGallery(parseGalleryItems(value));
}

export function parseImageArtifactGallery(
  value: string | string[] | undefined,
): ImageArtifactPreviewTarget[] | undefined {
  const pictures = parseGalleryItems(value)
    .filter(({ mimeType }) => isInlineImageMimeType(mimeType))
    .map(({ id: artifactId, name, mimeType }) => ({ artifactId, name, mimeType }));
  return pictures.length > 1 ? pictures : undefined;
}

export function galleryIndex(gallery: readonly ArtifactGalleryItem[], id: string): number {
  return gallery.findIndex((item) => item.id === id);
}
