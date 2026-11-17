import { artifactPreviewKind } from "@rakazo/contracts";

/** The fields the artifact pager needs without fetching content. */
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

/** A route param can be missing, a repeated deep-link value, or from an older app version. */
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
  const seen = new Set<string>();
  const gallery: ArtifactGalleryItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.name !== "string" ||
      typeof candidate.mimeType !== "string" ||
      seen.has(candidate.id) ||
      !isMediaArtifact({ mimeType: candidate.mimeType })
    )
      continue;
    seen.add(candidate.id);
    gallery.push({
      id: candidate.id,
      name: candidate.name,
      mimeType: candidate.mimeType,
    });
  }
  return gallery;
}

export function galleryIndex(gallery: readonly ArtifactGalleryItem[], id: string): number {
  return gallery.findIndex((item) => item.id === id);
}
