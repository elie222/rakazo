import { artifactPreviewKind } from "@rakazo/contracts";

export type ArtifactGalleryItem = {
  id: string;
  name: string;
  mimeType: string;
};

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

export function parseArtifactGallery(value: string | string[] | undefined): ArtifactGalleryItem[] {
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
  return mediaArtifactGallery(items);
}

export function galleryIndex(gallery: readonly ArtifactGalleryItem[], id: string): number {
  return gallery.findIndex((item) => item.id === id);
}
