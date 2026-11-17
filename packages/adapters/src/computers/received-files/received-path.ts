import { attachmentExtensionForMimeType } from "@rakazo/core";

/** Received copies older than this are pruned. */
export const RECEIVED_FILE_MAX_AGE_MS = 31 * 24 * 60 * 60_000;

const MAX_SENDER_CODE_POINTS = 32;
const MAX_NAME_CODE_POINTS = 64;
/** Common file-system limit for one file name, in UTF-8 bytes. */
const MAX_FILE_NAME_BYTES = 255;

function withoutTrailingDots(value: string): string {
  return value.replace(/[. ]+$/, "");
}

/** One safe path segment: no separators, dot runs, control or format characters, leading dots. */
function safeSegment(value: string, maxCodePoints: number): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[/\\]/g, "")
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
    if (Buffer.byteLength(candidate) <= MAX_FILE_NAME_BYTES) break;
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
 * Where a received chat-app file is copied in the bot's computer, relative to its workspace:
 * `shared/received/YYYY/MM/YYYY-MM-DD_HHMM_<sender>_<name>.<ext>` on a team computer,
 * `received/…` on a dedicated one. Dates use the given time zone. A `-2`, `-3`… counter keeps
 * it from overwriting a path `taken` reports as used.
 */
export function receivedFilePath(input: {
  at: Date;
  timeZone: string;
  sender: string;
  name: string | undefined;
  mimeType: string;
  computerMode: "team" | "dedicated";
  taken: (path: string) => boolean;
}): string {
  const { year, month, day, hour, minute } = localDateParts(input.at, input.timeZone);
  const extension = attachmentExtensionForMimeType(input.mimeType);
  const sender = safeSegment(input.sender, MAX_SENDER_CODE_POINTS) || "unknown";
  let name = safeSegment(input.name ?? "", MAX_NAME_CODE_POINTS);
  if (extension && name.toLowerCase().endsWith(extension)) {
    name = withoutTrailingDots(name.slice(0, -extension.length));
  }
  name ||= mediaKind(input.mimeType);

  const root = input.computerMode === "team" ? "shared/received" : "received";
  const folder = `${root}/${year}/${month}`;
  const prefix = `${year}-${month}-${day}_${hour}${minute}_${sender}_`;
  let path = `${folder}/${fitFileName(prefix, name, extension)}`;
  for (let counter = 2; input.taken(path); counter += 1) {
    path = `${folder}/${fitFileName(prefix, name, `-${counter}${extension}`)}`;
  }
  return path;
}
