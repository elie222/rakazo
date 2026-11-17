import { trimEndChars } from "@rakazo/contracts";

/**
 * The video call services a person names by name when they ask a bot to join. Not covered: Zoom
 * personal-room links (`/my/<name>`), the government Teams subdomains (only `teams.microsoft.us` itself), short links such as `g.co/meet`,
 * and links wrapped by a mail scanner's redirect.
 */
export type MeetingService = "meet" | "zoom" | "teams";

export interface MeetingLink {
  service: MeetingService;
  /** The meeting's own code or number; the same meeting reached by two links has one id. */
  id: string;
  /** https only, without tracking parameters or a fragment. Keeps the passcode, so treat it as a secret. */
  url: string;
}

interface Layout {
  /** Whether a subdomain of a host belongs to the service, such as `us02web.zoom.us`. */
  subdomains: boolean;
  hosts: readonly string[];
  /** The query parameters needed to get in, such as a passcode. Everything else is dropped. */
  keep: readonly string[];
  /** Whether a kept query value is usable; a value that fails is dropped. */
  valid?: (key: string, value: string) => boolean;
  /** The meeting id for these path segments, or undefined when they are not a meeting. */
  idOf: (segments: readonly string[]) => string | undefined;
}

const digits = (min: number, max: number) => (text: string | undefined) =>
  text !== undefined && text.length >= min && text.length <= max && /^\d+$/.test(text);
const zoomId = digits(9, 11);
const teamsId = digits(9, 15);

/** A meetup-join thread id, decoded so that `%3a` and `%3A` name one meeting. */
function threadId(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return /^19:meeting_[^/\s]+@thread\.(?:v2|skype)$/i.test(id) ? id : undefined;
}

/** Whether a Teams `context` value is the JSON object it should be, and not a cut-off copy. */
function jsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const SERVICES: Record<MeetingService, Layout> = {
  meet: {
    subdomains: false,
    hosts: ["meet.google.com"],
    keep: [],
    idOf: ([code, ...rest]) =>
      rest.length === 0 && code !== undefined && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)
        ? code
        : undefined,
  },
  zoom: {
    subdomains: true,
    hosts: ["zoom.us", "zoomgov.com"],
    keep: ["pwd"],
    idOf: (segments) => {
      const [first, second, third] = segments;
      if ((first === "j" || first === "w") && segments.length === 2 && zoomId(second)) {
        return second;
      }
      if (first === "wc" && second === "join" && segments.length === 3 && zoomId(third)) {
        return third;
      }
      return undefined;
    },
  },
  teams: {
    subdomains: false,
    hosts: ["teams.microsoft.com", "teams.microsoft.us", "teams.live.com"],
    keep: ["p", "context"],
    valid: (key, value) => key !== "context" || jsonObject(value),
    idOf: (segments) => {
      const [first, second, third] = segments;
      if (first === "meet" && segments.length === 2 && teamsId(second)) return second;
      if (first === "l" && second === "meetup-join" && segments.length <= 5) {
        return threadId(third);
      }
      return undefined;
    },
  },
};

function hostBelongs(host: string, layout: Layout): boolean {
  return layout.hosts.some(
    (name) => host === name || (layout.subdomains && host.endsWith(`.${name}`)),
  );
}

/**
 * The meeting a link joins, or null when it is not a link to one: another scheme, a host that
 * only ends like a service's, an address with a login in it, or a page of the service that is not
 * a meeting (a pricing page, a sign-in). Never throws.
 */
export function parseMeetingLink(input: unknown): MeetingLink | null {
  if (typeof input !== "string") return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = trimEndChars(url.hostname.toLowerCase(), ".");
  const segments = trimEndChars(url.pathname, "/").split("/").slice(1);
  for (const [service, layout] of Object.entries(SERVICES) as [MeetingService, Layout][]) {
    if (!hostBelongs(host, layout)) continue;
    const id = layout.idOf(segments);
    if (!id) return null;
    const query = new URLSearchParams();
    for (const key of layout.keep) {
      const value = url.searchParams.get(key);
      if (value && (layout.valid?.(key, value) ?? true)) query.set(key, value);
    }
    const search = query.toString();
    return {
      service,
      id,
      url: `https://${host}${trimEndChars(url.pathname, "/")}${search ? `?${search}` : ""}`,
    };
  }
  return null;
}

const LINK_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const ENTITY = /&(amp|lt|gt|quot|#0*38|#x0*26);/gi;
const ENTITY_TEXT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const MAX_DEPTH = 8;
const MAX_VALUES = 5_000;
const MAX_TEXT = 1_000_000;
const MAX_LINKS = 20;

/**
 * The meetings linked anywhere in a value such as a calendar event's text, location or nested
 * fields, in the order found and once per meeting (the copy that carries a passcode wins). It reads
 * every string and no particular field, so it works on whatever a calendar connector returns.
 * Values are read level by level, so an event's own fields come before long lists inside it. It
 * stops at a fixed depth, number of values and amount of text, and a link cut off by the text limit
 * is left out rather than read short. It reads plain objects and arrays by their own data
 * properties, never running a getter, skips a value that throws when inspected, and ignores
 * everything else. Never throws.
 */
export function findMeetingLinks(value: unknown): MeetingLink[] {
  const found = new Map<string, MeetingLink>();
  const seen = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let text = 0;
  for (let head = 0; head < queue.length && found.size < MAX_LINKS; head += 1) {
    if (values >= MAX_VALUES || text >= MAX_TEXT) break;
    const { value: current, depth } = queue[head]!;
    values += 1;
    if (typeof current === "string") {
      let part = current.slice(0, MAX_TEXT - text);
      text += part.length;
      if (part.length < current.length) part = part.slice(0, lastBreak(part));
      for (const match of part
        .replace(ENTITY, (_, name: string) => ENTITY_TEXT[name.toLowerCase()] ?? "&")
        .match(LINK_IN_TEXT) ?? []) {
        const link = parseMeetingLink(trimEndChars(match, ".,;:!?)]}*~"));
        if (!link) continue;
        const key = `${link.service}:${link.id}`;
        const earlier = found.get(key);
        if (!earlier || keptParameters(link) > keptParameters(earlier)) found.set(key, link);
        if (found.size >= MAX_LINKS) break;
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

/** The end of the last whole word, so a string cut mid-link never yields a shorter link. */
function lastBreak(text: string): number {
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (/\s/.test(text[at]!)) return at;
  }
  return 0;
}

function ownValue(object: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
