import { attachmentExtensionForMimeType } from "@rakazo/core";

/** Received copies older than this are pruned. */
export const RECEIVED_FILE_MAX_AGE_MS = 31 * 24 * 60 * 60_000;

const MAX_SEGMENT_LENGTH = 80;

/** One safe path segment: no separators, dot runs, control characters or leading dots. */
function safeSegment(value: string): string {
  return value
    .replace(/\p{Cc}/gu, "")
    .replace(/[/\\]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, MAX_SEGMENT_LENGTH);
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
  const sender = safeSegment(input.sender) || "unknown";
  let name = safeSegment(input.name ?? "");
  if (extension && name.toLowerCase().endsWith(extension)) {
    name = name.slice(0, -extension.length);
  }
  name ||= mediaKind(input.mimeType);

  const root = input.computerMode === "team" ? "shared/received" : "received";
  const folder = `${root}/${year}/${month}`;
  const stem = `${folder}/${year}-${month}-${day}_${hour}${minute}_${sender}_${name}`;
  let path = `${stem}${extension}`;
  for (let counter = 2; input.taken(path); counter += 1) {
    path = `${stem}-${counter}${extension}`;
  }
  return path;
}
