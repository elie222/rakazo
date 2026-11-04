import type { SourceLink } from "../alternatives";
import type { ArticleImage } from "../provider-article/types";
import { GITHUB_URL } from "../site";

export const VOICE_PROVIDERS_PATH = "/voice-providers/";
export const VOICE_PROVIDERS_UPDATED = "November 4, 2026";
export const VOICE_DOCS_PATH = "/docs/voice-and-calls/";

export function voiceProviderPath(slug: string): string {
  return `${VOICE_PROVIDERS_PATH}${slug}/`;
}

/** A screenshot in `public/graphics/voice-providers/`. */
export function homepage(slug: string, provider: string, alt: string): ArticleImage {
  return {
    webp: `/graphics/voice-providers/${slug}.webp`,
    avif: `/graphics/voice-providers/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const VOICE_DOC: SourceLink = {
  label: "Rakazo, voice and calls",
  href: `${GITHUB_URL}/blob/main/docs/voice-and-calls.md`,
};

export const VOICE_MODELS_DOC: SourceLink = {
  label: "Rakazo, self-hosted voice settings",
  href: `${GITHUB_URL}/blob/main/docs/self-host-models.md#voice`,
};
