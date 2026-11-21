import {
  attachmentExtensionForMimeType,
  ownExtensionForMimeType,
  sanitizeMessagingLabel,
} from "@rakazo/core";

/** Matches the `YYYY-MM-DD_HHMM_` date stamp a readable attachment copy starts its name with. */
export const ATTACHMENT_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}_/;

const MAX_SENDER_CODE_POINTS = 32;
const MAX_NAME_CODE_POINTS = 64;
/** Common file-system limit for one file name, in UTF-8 bytes. */
const MAX_FILE_NAME_BYTES = 255;

const encoder = new TextEncoder();

function withoutTrailingDots(value: string): string {
  return value.replace(/[. ]+$/, "");
}

/**
 * One safe path segment: no separators, dot runs, control or format characters, lone halves of
 * a surrogate pair or leading dots, and `_` for each character Windows does not allow in a name.
 */
function safeSegment(value: string, maxCodePoints: number): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[:*?<>|"\\]/g, "_")
    .replace(/\//g, "")
    .replace(/\.{2,}/g, "")
    .replace(/^\.+/, "")
    .trim();
  return withoutTrailingDots(Array.from(cleaned).slice(0, maxCodePoints).join(""));
}

/** The file name, with the name part trimmed (never mid code point) to fit the byte limit. */
function fitFileName(prefix: string, name: string, suffix: string): string {
  const chars = Array.from(name);
  while (chars.length > 1) {
    const candidate = `${prefix}${chars.join("")}${suffix}`;
    if (encoder.encode(candidate).length <= MAX_FILE_NAME_BYTES) break;
    chars.pop();
  }
  return `${prefix}${withoutTrailingDots(chars.join("")) || chars.join("")}${suffix}`;
}

function mediaKind(mimeType: string): string {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  return "file";
}

function localDateParts(at: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/**
 * Where an attachment copy lives in the bot's computer, relative to its workspace:
 * `attachments/YYYY/MM/YYYY-MM-DD_HHMM[_sender]_<name><ext>`, or without the year and month
 * folders for `folders: "none"`. Dates use the given time zone. The first `attempt` has no
 * counter; later ones add `-<attempt>` before the extension.
 */
export function attachmentPath(input: {
  at: Date;
  timeZone: string;
  sender?: string;
  name: string;
  mimeType: string;
  attempt: number;
  folders: "month" | "none";
}): string {
  const { year, month, day, hour, minute } = localDateParts(input.at, input.timeZone);
  const extension = attachmentExtensionForMimeType(input.mimeType);
  const sender = safeSegment(sanitizeMessagingLabel(input.sender ?? ""), MAX_SENDER_CODE_POINTS);
  let name = safeSegment(sanitizeMessagingLabel(input.name), MAX_NAME_CODE_POINTS);
  // The name's own extension goes in any spelling, so `IMG_1234.JPEG` does not end in `.JPEG.jpg`.
  const own = ownExtensionForMimeType(name, input.mimeType);
  if (own) name = withoutTrailingDots(name.slice(0, -own.length));
  name ||= mediaKind(input.mimeType);

  const folder = input.folders === "month" ? `attachments/${year}/${month}` : "attachments";
  const prefix = `${year}-${month}-${day}_${hour}${minute}_${sender ? `${sender}_` : ""}`;
  const counter = input.attempt > 1 ? `-${input.attempt}` : "";
  return `${folder}/${fitFileName(prefix, name, `${counter}${extension}`)}`;
}

function choice<T extends string>(
  source: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = source[key]?.trim();
  if (!value) return fallback;
  const match = allowed.find((option) => option === value);
  if (!match) throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  return match;
}

/** How attachment copies are named: `ATTACHMENT_COPY_NAMES` and `ATTACHMENT_COPY_FOLDERS`. */
export type AttachmentNaming = {
  names: "id" | "readable";
  folders: "none" | "month";
};

/** The attachment-copy settings `ATTACHMENT_COPY_NAMES` and `ATTACHMENT_COPY_FOLDERS`. */
export function attachmentNamingFromEnv(source: NodeJS.ProcessEnv): AttachmentNaming {
  return {
    names: choice(source, "ATTACHMENT_COPY_NAMES", ["id", "readable"], "id"),
    folders: choice(source, "ATTACHMENT_COPY_FOLDERS", ["none", "month"], "none"),
  };
}

/**
 * `ATTACHMENT_COPY_ON_ARRIVAL=true` copies incoming attachments into the bot's computer as they
 * arrive; off by default. Only the API reads it.
 */
export function copyAttachmentsOnArrivalFromEnv(source: NodeJS.ProcessEnv): boolean {
  return source.ATTACHMENT_COPY_ON_ARRIVAL === "true";
}
