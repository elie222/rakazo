import { isInlineImageMimeType } from "../messages/inline-image";

export type ImageArtifactPreviewTarget = {
  artifactId: string;
  name: string;
  mimeType: string;
};

function isPicture(value: unknown): value is ImageArtifactPreviewTarget {
  return (
    value !== null &&
    typeof value === "object" &&
    "artifactId" in value &&
    typeof value.artifactId === "string" &&
    value.artifactId.length > 0 &&
    "name" in value &&
    typeof value.name === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string" &&
    isInlineImageMimeType(value.mimeType)
  );
}

export function galleryPictures(raw: string): ImageArtifactPreviewTarget[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const pictures = parsed.filter(isPicture);
    return pictures.length > 1 ? pictures : undefined;
  } catch {
    return undefined;
  }
}
