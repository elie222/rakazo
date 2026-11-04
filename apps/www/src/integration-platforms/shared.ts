import type { SourceLink } from "../alternatives";
import type { ArticleImage } from "../provider-article/types";
import { GITHUB_URL } from "../site";

export const INTEGRATION_PLATFORMS_PATH = "/integration-platforms/";
export const INTEGRATION_PLATFORMS_UPDATED = "November 4, 2026";
export const INTEGRATIONS_DOCS_PATH = "/docs/self-host-integrations/";
export const CONNECT_APPS_DOCS_PATH = "/docs/integrations/";
export const INTEGRATIONS_CATALOG_PATH = "/integrations/";

export function integrationPlatformPath(slug: string): string {
  return `${INTEGRATION_PLATFORMS_PATH}${slug}/`;
}

/** A homepage screenshot in `public/graphics/integration-platforms/`. */
export function homepage(slug: string, provider: string, alt: string): ArticleImage {
  return {
    webp: `/graphics/integration-platforms/${slug}.webp`,
    avif: `/graphics/integration-platforms/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const INTEGRATIONS_DOC: SourceLink = {
  label: "Rakazo, tools and integrations",
  href: `${GITHUB_URL}/blob/main/docs/self-host-integrations.md`,
};
