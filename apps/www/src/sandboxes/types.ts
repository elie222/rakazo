import type { ArticleImage, ArticleSection, ProviderArticle } from "../provider-article/types";

export type SandboxImage = ArticleImage;
export type SandboxSection = ArticleSection;

/** A place a bot's computer can run. The page is served at `/sandboxes/${slug}/`. */
export type Sandbox = ProviderArticle & {
  /** Hub comparison: where the computer runs and what survives between sessions. */
  runsOn: string;
  keeps: string;
};
