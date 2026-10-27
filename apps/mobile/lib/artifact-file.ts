import { attachmentExtensionForMimeType } from "@rakazo/core";

export function artifactCacheFileName(artifactId: string, mimeType: string): string {
  const safeId = artifactId.replace(/[^A-Za-z0-9_-]/g, "_") || "attachment";
  return `${safeId}${attachmentExtensionForMimeType(mimeType)}`;
}

/** Filename for the share sheet. Uses the display name, never the storage id. */
export function artifactShareFileName(name: string, mimeType: string): string {
  const ext = attachmentExtensionForMimeType(mimeType);
  const trimmed = name.trim();
  const stemSource =
    ext && trimmed.toLowerCase().endsWith(ext.toLowerCase())
      ? trimmed.slice(0, -ext.length)
      : trimmed;
  const characters = Array.from(stemSource);
  const stem = characters
    .map((character, index) => {
      if (character !== "\u200c" && character !== "\u200d") return character;
      const adjacentLetterOrMark = /^[\p{L}\p{M}]$/u;
      return adjacentLetterOrMark.test(characters[index - 1] ?? "") &&
        adjacentLetterOrMark.test(characters[index + 1] ?? "")
        ? character
        : "\ufffd";
    })
    .join("")
    .replace(/(?:(?!\u200c|\u200d)[^\p{L}\p{M}\p{N}._-])+/gu, "_")
    .replace(/^\.+/, "")
    .replace(/^_+|_+$/g, "");
  let boundedStem = stem;
  if (stem.length > 80) {
    boundedStem = "";
    if (typeof Intl.Segmenter === "function") {
      const segments: string[] = [];
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        stem,
      )) {
        if (boundedStem.length + segment.length > 80) break;
        segments.push(segment);
        boundedStem += segment;
      }
      // A joiner belongs with its following character even if the segmenter
      // groups it with the preceding grapheme.
      if (/[\u200c\u200d]\p{M}*$/u.test(boundedStem)) {
        segments.pop();
        boundedStem = segments.join("");
      }
    }
  }
  return `${boundedStem && !/^[\p{M}_\u200c\u200d]+$/u.test(boundedStem) ? boundedStem : "attachment"}${ext}`;
}
