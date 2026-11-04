import type { FaqItem, SourceLink } from "../alternatives";
import type { SandboxSceneProps } from "../components/SandboxScene";

export type SandboxImage = {
  webp: string;
  avif?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
};

/**
 * One part of a sandbox article. Text may use `code` and [links](/path/) or
 * [links](https://example.com).
 */
export type SandboxSection = {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  /** Numbered steps, for setup. */
  steps?: readonly string[];
  /** Show the page's image after this section's text. */
  image?: boolean;
};

export type Sandbox = {
  /** Path segment. The page is served at `/sandboxes/${slug}/`. */
  slug: string;
  /** Short name used on cards, the hub table and links between pages. */
  name: string;
  /** Hub comparison: where the computer runs, what survives between sessions, who it suits. */
  runsOn: string;
  keeps: string;
  bestFor: string;
  title: string;
  description: string;
  h1: string;
  /** Opening paragraphs, shown above the scene. */
  intro: readonly string[];
  /** The bot-at-work illustration under the intro. */
  scene: SandboxSceneProps;
  sections: readonly SandboxSection[];
  /** The provider's homepage, or a product screenshot. Also the card thumbnail. */
  image: SandboxImage;
  faq: readonly FaqItem[];
  sources: readonly SourceLink[];
};
