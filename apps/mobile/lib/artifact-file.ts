import { attachmentExtensionForMimeType, truncatePlainText } from "@rakazo/core";

const STEM_MAX_LENGTH = 80;
// Joiners are kept only between letters or marks, where scripts such as Persian need them.
const UNSAFE_RUN =
  /(?:(?!\u200c|\u200d)[^\p{L}\p{M}\p{N}._-]|(?<![\p{L}\p{M}])(?:\u200c|\u200d)|(?:\u200c|\u200d)(?![\p{L}\p{M}]))+/gu;

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
  const stem = boundedStem(
    stemSource
      .replace(UNSAFE_RUN, "_")
      .replace(/^\.+/, "")
      .replace(/^_+|_+$/g, ""),
  ).replace(/(?:\u200c|\u200d)\p{M}*$/u, "");
  return `${stem && !/^(?:\p{M}|_|\u200c|\u200d)+$/u.test(stem) ? stem : "attachment"}${ext}`;
}

function boundedStem(stem: string): string {
  if (stem.length <= STEM_MAX_LENGTH || typeof Intl.Segmenter !== "function") {
    return truncatePlainText(stem, STEM_MAX_LENGTH);
  }
  let end = 0;
  for (const { index, segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(stem)) {
    if (index + segment.length > STEM_MAX_LENGTH) break;
    end = index + segment.length;
  }
  return stem.slice(0, end);
}
