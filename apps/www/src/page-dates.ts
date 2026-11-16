import { ALTERNATIVES, alternativePath, ROUNDUP_UPDATED } from "./alternatives";
import { blogUpdatedDates } from "./blog/indexability";
import { GROK_ALTERNATIVE_PATH, GROK_UPDATED } from "./grok-alternative";
import { OPENCLAW_UPDATED } from "./guide";
import {
  INTEGRATION_PLATFORMS,
  INTEGRATION_PLATFORMS_PATH,
  INTEGRATION_PLATFORMS_UPDATED,
  integrationPlatformPath,
} from "./integration-platforms";
import { SANDBOXES, SANDBOXES_PATH, SANDBOXES_UPDATED, sandboxPath } from "./sandboxes";
import { OPENCLAW_ALTERNATIVE_PATH } from "./site";
import {
  VOICE_PROVIDERS,
  VOICE_PROVIDERS_PATH,
  VOICE_PROVIDERS_UPDATED,
  voiceProviderPath,
} from "./voice-providers";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A date the site shows, such as "October 24, 2026", as `2026-10-24`. */
export function isoFromDisplayDate(value: string): string {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const month = match ? MONTHS.indexOf(match[1] ?? "") + 1 : 0;
  if (!match || month === 0) throw new Error(`Not a display date: ${value}`);
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[2]?.padStart(2, "0")}`;
}

function hub(path: string, updated: string, detailPaths: readonly string[]): [string, string][] {
  return [path, ...detailPaths].map((page) => [page, updated]);
}

function newest(dates: Iterable<string>): string | undefined {
  return [...dates].sort().at(-1);
}

/**
 * The date each page says it was last updated, as an ISO date, keyed by path. Pages that show
 * no date are left out rather than given the build time.
 */
export function pageDates(): ReadonlyMap<string, string> {
  const blog = blogUpdatedDates();
  const blogIndex = newest(blog.values());
  return new Map([
    ...[
      ...hub("/alternatives/", ROUNDUP_UPDATED, []),
      ...ALTERNATIVES.map((page): [string, string] => [alternativePath(page), page.comparedOn]),
      [GROK_ALTERNATIVE_PATH, GROK_UPDATED] as [string, string],
      [OPENCLAW_ALTERNATIVE_PATH, OPENCLAW_UPDATED] as [string, string],
      ...hub(
        SANDBOXES_PATH,
        SANDBOXES_UPDATED,
        SANDBOXES.map((item) => sandboxPath(item.slug)),
      ),
      ...hub(
        INTEGRATION_PLATFORMS_PATH,
        INTEGRATION_PLATFORMS_UPDATED,
        INTEGRATION_PLATFORMS.map((item) => integrationPlatformPath(item.slug)),
      ),
      ...hub(
        VOICE_PROVIDERS_PATH,
        VOICE_PROVIDERS_UPDATED,
        VOICE_PROVIDERS.map((item) => voiceProviderPath(item.slug)),
      ),
    ].map(([path, date]): [string, string] => [path, isoFromDisplayDate(date)]),
    ...[...blog].map(([slug, date]): [string, string] => [`/blog/${slug}/`, date]),
    ...(blogIndex ? [["/blog/", blogIndex] as [string, string]] : []),
  ]);
}

let cached: ReadonlyMap<string, string> | undefined;

/** The ISO date a page was last updated, or undefined when it shows none. */
export function pageDate(pathname: string): string | undefined {
  cached ??= pageDates();
  return cached.get(pathname.endsWith("/") ? pathname : `${pathname}/`);
}
