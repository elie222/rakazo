import type { CollectionEntry, CollectionKey } from "astro:content";
import type { AstroIntegration } from "astro";
import type { Locale } from "./i18n/locales";

/**
 * Marketing pages beyond the home page and docs are cloned into `src/marketing/` at build time. Without it the site builds the home page
 * and docs alone, and every link into marketing pages is left dangling.
 */

export type AgentResource = { id: string; name: string; path: string; summary?: string };

export type AgentResourceGroup = { id: string; heading: string; resources: AgentResource[] };

export type AgentCatalogEntry = {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description?: string;
};

type GetCollection = <C extends CollectionKey>(collection: C) => Promise<CollectionEntry<C>[]>;

export type MarketingSite = {
  /** Adds the marketing routes and the files they serve. */
  integration?: AstroIntegration;
  /** False for a built page that stays out of the sitemap. */
  isIndexedPath(pathname: string): boolean;
  /** The ISO date a page says it was last updated. */
  pageDate(pathname: string): string | undefined;
  footerAlternatives: readonly { href: string; name: string }[];
  /**
   * Marketing pages built in more languages than English, keyed by English path, with the locales
   * each one is built in. Each becomes a `/{locale}/path/` hreflang alternate and a language-switcher
   * target; the build fails if one is listed but not built, or built but not listed.
   */
  translatedPages?: Readonly<Record<string, readonly Locale[]>>;
  /** The top of `llms.txt`, up to the generated resource lists. */
  agentInstructionsIntro?: string;
  agentDocumentationPath?: string;
  agentCatalogEntries: readonly AgentCatalogEntry[];
  agentResourceGroups(getCollection: GetCollection): Promise<AgentResourceGroup[]>;
};

const NO_MARKETING: MarketingSite = {
  isIndexedPath: () => true,
  pageDate: () => undefined,
  footerAlternatives: [],
  agentCatalogEntries: [],
  agentResourceGroups: async () => [],
};

const found = import.meta.glob<{ marketing: MarketingSite }>("./marketing/index.ts", {
  eager: true,
});

export const marketing: MarketingSite = found["./marketing/index.ts"]?.marketing ?? NO_MARKETING;
