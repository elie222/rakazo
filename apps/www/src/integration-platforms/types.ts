import type { ProviderArticle } from "../provider-article/types";

/** A way bots get tools for other apps. The page is served at `/integration-platforms/${slug}/`. */
export type IntegrationPlatform = ProviderArticle & {
  /** Hub comparison: what it gives bots and who keeps the app logins. */
  gives: string;
  logins: string;
};
