import { attachmentExtensionForMimeType } from "@rakazo/core";
import emojiRegex from "emoji-regex";

// Older native engines may not recognize this Unicode property.
const emojiPresentation = (() => {
  try {
    // biome-ignore lint/complexity/useRegexLiterals: A literal would fail to parse on engines without this property.
    return new RegExp("\\p{Emoji_Presentation}", "u");
  } catch {
    return null;
  }
})();

function isEmojiSequence(segment: string, matcher: RegExp): boolean {
  if (!emojiPresentation || /^[\u{1f3fb}-\u{1f3ff}]$/u.test(segment)) return false;
  // Digits have an emoji presentation sequence even without an enclosing keycap.
  if (/^[0-9]\ufe0f$/u.test(segment)) return true;
  const match = (text: string) => {
    matcher.lastIndex = 0;
    const result = matcher.exec(text);
    return result?.index === 0 && result[0] === text;
  };
  if (match(segment)) {
    return (
      emojiPresentation.test(segment) || segment.includes("\ufe0f") || segment.includes("\u20e3")
    );
  }
  // Some filenames append an explicit emoji selector to a default-emoji character.
  if (segment.endsWith("\ufe0f")) {
    const base = segment.slice(0, -1);
    return !base.endsWith("\ufe0f") && emojiPresentation.test(base) && match(base);
  }
  return false;
}

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
  const emojiUnits = new Uint8Array(stemSource.length);
  if (typeof Intl.Segmenter === "function" && emojiPresentation) {
    const matcher = emojiRegex();
    for (const { segment, index } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(stemSource)) {
      if (isEmojiSequence(segment, matcher)) emojiUnits.fill(1, index, index + segment.length);
    }
  }
  let offset = 0;
  const stem = characters
    .map((character, index) => {
      const isEmoji = emojiUnits[offset] === 1;
      offset += character.length;
      if (isEmoji) return character;
      // These marks have meaning in a validated emoji sequence, but must not
      // make an otherwise isolated text joiner appear valid.
      if (
        (character === "\ufe0e" || character === "\ufe0f") &&
        /^[0-9]$/u.test(characters[index - 1] ?? "")
      )
        return character;
      if (character === "\ufe0e" || character === "\ufe0f" || character === "\u20e3") return "";
      if (
        /^[\ufe00-\ufe0d\u{e0100}-\u{e01ef}]$/u.test(character) &&
        !/^[\p{L}\p{N}]$/u.test(characters[index - 1] ?? "")
      )
        return "";
      if (character === "\u200c" || character === "\u200d") {
        const isTextNeighbor = (value: string) =>
          !/^[\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u20e3]$/u.test(value) &&
          /^[\p{L}\p{M}]$/u.test(value);
        return isTextNeighbor(characters[index - 1] ?? "") &&
          isTextNeighbor(characters[index + 1] ?? "")
          ? character
          : "\ufffd";
      }
      return /^[\p{L}\p{M}\p{N}._-]$/u.test(character) ? character : "\ufffd";
    })
    .join("")
    .replace(/\ufffd+/g, "_")
    .replace(/^\.+/, "")
    .replace(/^_+|_+$/g, "");
  let boundedStem = stem;
  if (stem.length > 80) {
    boundedStem = "";
    if (typeof Intl.Segmenter === "function") {
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        stem,
      )) {
        if (boundedStem.length + segment.length > 80) break;
        boundedStem += segment;
      }
    } else if (/^[A-Za-z0-9._-]*$/u.test(stem)) {
      boundedStem = stem.slice(0, 80);
    }
  }
  boundedStem = boundedStem.replace(/(?:\u200c|\u200d)\p{M}*$/u, "");
  return `${boundedStem && !/^[\p{M}_\u200c\u200d]+$/u.test(boundedStem) ? boundedStem : "attachment"}${ext}`;
}
