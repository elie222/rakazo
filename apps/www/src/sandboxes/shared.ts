import { BYOK_TIERS, COMPUTER_SIZE_SPECS, sandboxAllowanceHours } from "@rakazo/contracts";
import type { SourceLink } from "../alternatives";
import { GITHUB_URL, SITE_URL } from "../site";
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

const CLOUD = BYOK_TIERS.standard;
const CLOUD_SPECS = COMPUTER_SIZE_SPECS[CLOUD.computerSize];

/** Rakazo Cloud's entry plan, from the constants the app bills with. */
export const CLOUD_PLAN = `${CLOUD.monthlyPriceCents === null ? "free" : `$${CLOUD.monthlyPriceCents / 100} a month`}, with ${Math.floor(sandboxAllowanceHours(CLOUD.computerAllowanceCents))} computer hours on ${CLOUD_SPECS.vcpus} vCPU / ${CLOUD_SPECS.memoryGb} GB included`;

/** Small print under every price table. */
export const PRICES_NOTE =
  "Prices in US dollars unless marked, from each provider's pricing page, checked November 2026. Your model provider bills separately.";

/** Pricing pages cited by more than one sandbox page. */
export const PRICING = {
  boat: { label: "Boat pricing", href: "https://boat.dev" },
  e2b: { label: "E2B pricing", href: "https://e2b.dev/pricing" },
  daytona: { label: "Daytona pricing", href: "https://www.daytona.io/pricing" },
  novita: { label: "Novita sandbox pricing", href: "https://docs.novita.ai/guides/sandbox-pricing" },
  railway: { label: "Railway sandboxes, pricing and limits", href: "https://docs.railway.com/sandboxes" },
  wuying: {
    label: "Alibaba Cloud, Elastic Desktop Service billing",
    href: "https://www.alibabacloud.com/help/en/wuying-workspace/product-overview/billing-overview",
  },
  modal: { label: "Modal pricing", href: "https://modal.com/pricing" },
  vercel: { label: "Vercel Sandbox pricing", href: "https://vercel.com/docs/vercel-sandbox/pricing" },
  northflank: { label: "Northflank pricing", href: "https://northflank.com/pricing" },
  blaxel: { label: "Blaxel pricing", href: "https://blaxel.ai/pricing" },
  createos: { label: "CreateOS sandbox pricing", href: "https://createos.sh/pricing/sandbox" },
  dockerSandboxes: {
    label: "Docker, Cloud Sandboxes",
    href: "https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/",
  },
  hetzner: { label: "Hetzner Cloud pricing", href: "https://www.hetzner.com/cloud/cost-optimized/" },
  digitalocean: { label: "DigitalOcean Droplet pricing", href: "https://www.digitalocean.com/pricing/droplets" },
  rakazo: { label: "Rakazo pricing", href: `${SITE_URL}/pricing/` },
} satisfies Record<string, SourceLink>;
