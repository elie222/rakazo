import { trimEndChars } from "@rakazo/contracts";

/**
 * What a recognizer reads from a link that already passed the checks every video call service
 * shares: https, no login and no port.
 */
export interface MeetingLinkParts {
  /** Lower case, without a trailing dot. */
  host: string;
  /** The path segments, without the empty one before the first slash or a trailing slash. */
  segments: readonly string[];
  query: URLSearchParams;
}

/** One video call service's link layout, supplied by its provider. Core never names a service. */
export interface MeetingLinkRecognizer {
  /** The provider's id, kept as the opaque `provider` of the links it recognizes. */
  id: string;
  /**
   * The meeting's own id and the query values needed to get in, such as a passcode, or undefined
   * when the link is not a meeting of this service: another host, or one of its pages that is
   * not a meeting. Everything else in the query is dropped.
   */
  recognize(
    parts: MeetingLinkParts,
  ): { id: string; params: Record<string, string | undefined> } | undefined;
}

export interface MeetingLink {
  /** The id of the recognizer that read it. */
  provider: string;
  /** The meeting's own code or number; the same meeting reached by two links has one id. */
  id: string;
  /** https only, without tracking parameters or a fragment. Keeps the passcode, so treat it as a secret. */
  url: string;
}

const TOKEN = /^[\w-]{1,512}$/;

/**
 * A query value that is a bare token, such as a passcode, or undefined. A value with anything
 * else in it is not guessed at or trimmed, so a passcode is returned exactly or not at all.
 */
export function meetingTokenParam(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  return value !== null && TOKEN.test(value) ? value : undefined;
}

/**
 * The meeting a link joins, or null when no recognizer reads it as one: another scheme, an
 * address with a login or a port, or a page of a service that is not a meeting. Never throws.
 */
export function parseMeetingLink(
  input: unknown,
  recognizers: readonly MeetingLinkRecognizer[],
): MeetingLink | null {
  if (typeof input !== "string") return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = trimEndChars(url.hostname.toLowerCase(), ".");
  const path = trimEndChars(url.pathname, "/");
  const parts: MeetingLinkParts = {
    host,
    segments: path.split("/").slice(1),
    query: url.searchParams,
  };
  for (const recognizer of recognizers) {
    const meeting = recognizer.recognize(parts);
    if (!meeting) continue;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(meeting.params)) if (value) query.set(key, value);
    const search = query.toString();
    return {
      provider: recognizer.id,
      id: meeting.id,
      url: `https://${host}${path}${search ? `?${search}` : ""}`,
    };
  }
  return null;
}

const LINK_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const LINK_END = /[\s<>"'`]/;
const ENTITY = /&(amp|lt|gt|quot|#0*38|#x0*26);/gi;
const ENTITY_TEXT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const MAX_DEPTH = 8;
const MAX_VALUES = 5_000;
const MAX_TEXT = 1_000_000;
/** How far past the text limit a link that straddles it is read, before it is left out. */
const MAX_LINK = 8_192;
const MAX_LINKS = 20;

/**
 * The meetings linked anywhere in a value such as a calendar event's text, location or nested
 * fields, in the order found and once per meeting (the copy that carries a passcode wins, even
 * one found after the limit on meetings is reached). It reads every string and no particular
 * field, so it works on whatever a calendar connector returns. Values are read level by level, so
 * an event's own fields come before long lists inside it. It stops at a fixed depth, number of
 * values and amount of text; a link that straddles the text limit is read to its end, or left out
 * when it has none within MAX_LINK characters, never read short. It reads plain objects and arrays
 * by their own data properties, never running a getter, skips a value that throws when inspected,
 * and ignores everything else. Never throws.
 */
export function findMeetingLinks(
  value: unknown,
  recognizers: readonly MeetingLinkRecognizer[],
): MeetingLink[] {
  const found = new Map<string, MeetingLink>();
  const seen = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let text = 0;
  for (let head = 0; head < queue.length; head += 1) {
    if (values >= MAX_VALUES || text >= MAX_TEXT) break;
    const { value: current, depth } = queue[head]!;
    values += 1;
    if (typeof current === "string") {
      const part = readThroughLink(current, MAX_TEXT - text);
      text += part.length;
      for (const match of part
        .replace(ENTITY, (_, name: string) => ENTITY_TEXT[name.toLowerCase()] ?? "&")
        .match(LINK_IN_TEXT) ?? []) {
        const link = parseMeetingLink(trimEndChars(match, ".,;:!?)]}*~"), recognizers);
        if (!link) continue;
        const key = `${link.provider}:${link.id}`;
        const earlier = found.get(key);
        if (earlier) {
          if (keptParameters(link) > keptParameters(earlier)) found.set(key, link);
        } else if (found.size < MAX_LINKS) {
          found.set(key, link);
        }
      }
      continue;
    }
    if (depth >= MAX_DEPTH || typeof current !== "object" || current === null) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const room = MAX_VALUES - queue.length;
    try {
      if (Array.isArray(current)) {
        for (let at = 0; at < Math.min(current.length, room); at += 1) {
          queue.push({ value: ownValue(current, String(at)), depth: depth + 1 });
        }
      } else if (isPlainObject(current)) {
        for (const key of Object.keys(current).slice(0, room)) {
          queue.push({ value: ownValue(current, key), depth: depth + 1 });
        }
      }
    } catch {
      // A proxy that throws on inspection is not connector data; skip it and read the rest.
    }
  }
  return [...found.values()];
}

/** How much of the way in a link carries, so the copy with the passcode replaces one without. */
function keptParameters(link: MeetingLink): number {
  return [...new URL(link.url).searchParams.keys()].length;
}

/**
 * The first `limit` characters, extended to the end of the link they stop in so it is never read
 * short. A link with no end within MAX_LINK characters is left out with the rest of its token.
 */
function readThroughLink(text: string, limit: number): string {
  if (limit >= text.length) return text;
  const stop = Math.min(text.length, limit + MAX_LINK);
  for (let at = limit; at < stop; at += 1) {
    if (LINK_END.test(text[at]!)) return text.slice(0, at);
  }
  if (stop === text.length) return text;
  for (let at = limit - 1; at >= 0; at -= 1) {
    if (LINK_END.test(text[at]!)) return text.slice(0, at);
  }
  return "";
}

function ownValue(object: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
