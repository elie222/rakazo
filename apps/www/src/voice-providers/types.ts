import type { ProviderArticle } from "../provider-article/types";

/** A voice provider bots speak and listen with. The page is served at `/voice-providers/${slug}/`. */
export type VoiceProvider = ProviderArticle & {
  /** Hub comparison: what it does (speaks, transcribes) and where it runs. */
  does: string;
  runs: string;
};
