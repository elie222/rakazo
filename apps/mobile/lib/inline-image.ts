export type ImageSize = { width: number; height: number };

/** Fit an image inside a box, keeping its aspect ratio and never scaling it up. */
export function fitImageSize(natural: ImageSize, maxWidth: number, maxHeight: number): ImageSize {
  const width = Math.max(1, natural.width);
  const height = Math.max(1, natural.height);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Raster formats the native Image component renders; SVG and unknown types keep the file card. */
export function isInlineImageMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return type.startsWith("image/") && type !== "image/svg+xml";
}

/**
 * Share one in-flight load per key so a list of bubbles does not fetch the same artifact
 * repeatedly. A failed load is forgotten, so the next render can retry.
 */
export function createKeyedPromiseCache<T>(load: (key: string) => Promise<T>) {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key: string): Promise<T> {
      const existing = entries.get(key);
      if (existing) return existing;
      const next = load(key).catch((error: unknown) => {
        entries.delete(key);
        throw error;
      });
      entries.set(key, next);
      return next;
    },
    /** Drop a key; with `entry`, only when that promise is still the one stored (single-flight retries). */
    forget(key: string, entry?: Promise<T>): void {
      if (entry === undefined || entries.get(key) === entry) entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
