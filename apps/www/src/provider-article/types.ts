import type { FaqItem, SourceLink } from "../alternatives";
import type { ProviderSceneProps } from "../components/ProviderScene";

export type ArticleImage = {
  webp: string;
  avif?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
};

/** A comparison table, such as prices across providers. Cells take the same markup as section text. */
export type ArticleTable = {
  caption: string;
  /** Column headings; the first labels the row headings. */
  columns: readonly string[];
  rows: readonly { topic: string; cells: readonly string[] }[];
  /** Small print under the table, such as when prices were checked. */
  note?: string;
};

/**
 * One part of a provider article. Text may use `code` and [links](/path/) or
 * [links](https://example.com).
 */
export type ArticleSection = {
  heading: string;
  /** Anchor for links to this section, such as `pricing`. */
  id?: string;
  paragraphs?: readonly string[];
  /** Shown after the paragraphs. */
  table?: ArticleTable;
  bullets?: readonly string[];
  /** Numbered steps, for setup. */
  steps?: readonly string[];
  /** Show the article's image after this section's text. */
  image?: boolean;
};

/** An article about one provider Rakazo supports, such as a sandbox or an integration platform. */
export type ProviderArticle = {
  /** Path segment under the article's hub. */
  slug: string;
  /** Short name used on cards, the hub table and links between articles. */
  name: string;
  /** Who it suits, shown on cards and the hub table. */
  bestFor: string;
  title: string;
  description: string;
  h1: string;
  /** Opening paragraphs, shown above the scene. */
  intro: readonly string[];
  /** The bot-at-work illustration under the intro. */
  scene: ProviderSceneProps;
  sections: readonly ArticleSection[];
  /** The provider's homepage, or a product screenshot. Also the card thumbnail. */
  image: ArticleImage;
  faq: readonly FaqItem[];
  sources: readonly SourceLink[];
};

/** A card or list entry pointing at another article. */
export type ArticleLink = {
  name: string;
  href: string;
  meta: string;
  image: ArticleImage;
};

/** The hub an article belongs to. */
export type ArticleHub = {
  /** Breadcrumb label, e.g. "Sandboxes for AI agents". */
  label: string;
  /** Link back to the hub under the cards, e.g. "Compare all sandboxes". */
  compareLabel: string;
  href: string;
  /** Heading above the cards for sibling articles. */
  moreHeading: string;
  /** Setup guide button. */
  guide: { label: string; href: string };
};
