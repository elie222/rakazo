import type {
  AdapterContext,
  ConnectorCatalogItem,
  ManagedConnectorProvider,
  ToolSearchHit,
} from "@rakazo/adapter-kit";
import { bestEffort } from "@rakazo/logging";
import type { ToolSearchSource } from "./tool-search.js";

/** Shorter words ("use", "the", "app") would match the start of too many app names. */
const MIN_PREFIX_LENGTH = 4;

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The apps people can connect, from every app catalog this deployment has: those the request names,
 * or whose name starts with one of its words. connect_app takes a hit's id.
 */
export function appCatalogSource(
  providers: readonly ManagedConnectorProvider[],
  context: AdapterContext,
): ToolSearchSource {
  const catalog = async () =>
    (
      await Promise.all(
        providers.map(
          async (provider) =>
            (await bestEffort(
              `app catalog ${provider.describe().id}`,
              provider.catalog(context),
            )) ?? [],
        ),
      )
    ).flat();
  return {
    label: "apps",
    async search(query, limit) {
      const queryWords = words(query);
      // Every run of up to four words, joined: "google calendar" names Google Calendar.
      const named = new Set(
        queryWords.flatMap((_, start) =>
          [1, 2, 3, 4].map((length) => queryWords.slice(start, start + length).join("")),
        ),
      );
      return dedupe(await catalog())
        .map((entry) => ({ entry, rank: appRank(entry, named, queryWords) }))
        .filter(({ rank }) => rank > 0)
        .sort((left, right) => right.rank - left.rank)
        .slice(0, limit)
        .map(({ entry }) => appHit(entry));
    },
    async find(ids) {
      const wanted = new Set(ids.map((id) => id.toLowerCase()));
      // Matched before deduplicating, so a slug only one catalog uses is still found.
      return dedupe(
        (await catalog()).filter(
          (entry) => wanted.has(entry.slug.toLowerCase()) || wanted.has(entry.name.toLowerCase()),
        ),
      ).map(appHit);
    },
  };
}

/**
 * 3: whole words of the request name the app; 2: one names a word of the app's name; 1: one
 * starts a word of it. Only whole words count, so "box" in "inbox" is not Box and "Pagesnapper"
 * is not Pagesnap, and short words never match part of a name, so "to" or "com" never find
 * "Microsoft To Do" or "Monday.com".
 */
function appRank(entry: ConnectorCatalogItem, named: Set<string>, queryWords: string[]): number {
  if ([squash(entry.name), squash(entry.slug)].some((name) => named.has(name))) return 3;
  const longWords = queryWords.filter((word) => word.length >= MIN_PREFIX_LENGTH);
  const nameWords = words(`${entry.name} ${entry.slug}`);
  if (longWords.some((word) => nameWords.includes(word))) return 2;
  return longWords.some((word) => nameWords.some((name) => name.startsWith(word))) ? 1 : 0;
}

/** An app several catalogs list counts once, as connected when any of them connected it. */
function dedupe(entries: ConnectorCatalogItem[]): ConnectorCatalogItem[] {
  const byName = new Map<string, ConnectorCatalogItem>();
  for (const entry of entries) {
    const key = squash(entry.name);
    const seen = byName.get(key);
    if (!seen || (entry.connected && !seen.connected)) byName.set(key, entry);
  }
  return [...byName.values()];
}

function appHit(entry: ConnectorCatalogItem): ToolSearchHit {
  return {
    id: entry.slug,
    name: entry.name,
    description: entry.connected ? "Connected." : "An app the user can connect.",
    next: "connect_app",
  };
}
