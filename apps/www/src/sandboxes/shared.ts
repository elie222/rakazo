import type { SourceLink } from "../alternatives";
import { GITHUB_URL } from "../site";
import type { SandboxImage } from "./types";

export const SANDBOXES_PATH = "/sandboxes/";
export const SANDBOXES_UPDATED = "November 4, 2026";
export const COMPUTER_PROVIDERS_DOCS_PATH = "/docs/self-host-sandbox-providers/";
export const COMPUTER_DOCS_PATH = "/docs/computer/";
export const SELF_HOST_PATH = "/self-hosted-ai-agent/";

export function sandboxPath(slug: string): string {
  return `${SANDBOXES_PATH}${slug}/`;
}

/** A provider homepage screenshot in `public/graphics/sandboxes/`. */
export function homepage(slug: string, provider: string, alt: string): SandboxImage {
  return {
    webp: `/graphics/sandboxes/${slug}.webp`,
    avif: `/graphics/sandboxes/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const PROVIDERS_DOC: SourceLink = {
  label: "Rakazo, computer providers",
  href: `${GITHUB_URL}/blob/main/docs/self-host-sandbox-providers.md`,
};

export const RUNTIME_DOC: SourceLink = {
  label: "Rakazo, computer runtime and isolation",
  href: `${GITHUB_URL}/blob/main/docs/computer-runtime.md`,
};
