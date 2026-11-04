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

/**
 * One part of a provider article. Text may use `code` and [links](/path/) or
 * [links](https://example.com).
 */
export type ArticleSection = {
  heading: string;
  paragraphs?: readonly string[];
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
