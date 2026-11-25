/**
 * The pictures of the message that opened the viewer, read back from the route. A group of one,
 * a broken payload or a picture without a name opens the picture alone.
 */
export function galleryPictures(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.flatMap((entry: unknown) =>
      entry && typeof entry === "object" && "artifactId" in entry && "name" in entry
        ? [
            {
              artifactId: String(entry.artifactId),
              name: String(entry.name),
              mimeType: String("mimeType" in entry ? entry.mimeType : "image/png"),
            },
          ]
        : [],
    );
    return list.length > 1 ? list : undefined;
  } catch {
    return undefined;
  }
}
