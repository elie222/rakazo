import { ALTERNATIVES, ALTERNATIVES_HUB } from "./alternatives";
import { GROK_ALTERNATIVE_H1 } from "./grok-alternative";
import { OPENCLAW_H1 } from "./guide";
import { INTEGRATION_PLATFORMS, INTEGRATION_PLATFORMS_HUB } from "./integration-platforms";
import { SANDBOXES, SANDBOXES_HUB } from "./sandboxes";
import { VOICE_PROVIDERS, VOICE_PROVIDERS_HUB } from "./voice-providers";

export type OgPage = {
  id: string;
  kicker: string;
  title: string;
};

const BLOG_OG: readonly OgPage[] = [
  {
    id: "blog-claude-duet-vs-grok-bot",
    kicker: "Comparison",
    title: "Claude Duet vs Grok Bot",
  },
  {
    id: "blog-best-open-source-ai-agents-2026",
    kicker: "Roundup",
    title: "Best open source AI agents in 2026",
  },
  {
    id: "blog-openclaw-vs-hermes-vs-rakazo",
    kicker: "Comparison",
    title: "OpenClaw vs Hermes Agent vs Rakazo",
  },
  {
    id: "blog-self-host-an-ai-agent",
    kicker: "Guide",
    title: "How to self-host an AI agent",
  },
];

/** One Open Graph image per marketing page that should not share the homepage image. */
export function ogPages(): OgPage[] {
  return [
    { id: "alternatives", kicker: "Alternatives", title: ALTERNATIVES_HUB.h1 },
    ...ALTERNATIVES.map((page) => ({
      id: page.slug,
      kicker: "Comparison",
      title: page.h1,
    })),
    { id: "grok-bot-alternative", kicker: "Alternatives", title: GROK_ALTERNATIVE_H1 },
    { id: "openclaw-alternative", kicker: "Comparison", title: OPENCLAW_H1 },
    {
      id: "self-hosted-ai-agent",
      kicker: "Guide",
      title: "Self-hosted AI agent",
    },
    { id: "sandboxes", kicker: "Comparison", title: SANDBOXES_HUB.h1 },
    ...SANDBOXES.map((sandbox) => ({
      id: `sandbox-${sandbox.slug}`,
      kicker: "Bot computers",
      title: sandbox.h1,
    })),
    { id: "integration-platforms", kicker: "Comparison", title: INTEGRATION_PLATFORMS_HUB.h1 },
    ...INTEGRATION_PLATFORMS.map((platform) => ({
      id: `integration-platform-${platform.slug}`,
      kicker: "Bot tools",
      title: platform.h1,
    })),
    { id: "voice-providers", kicker: "Comparison", title: VOICE_PROVIDERS_HUB.h1 },
    ...VOICE_PROVIDERS.map((provider) => ({
      id: `voice-provider-${provider.slug}`,
      kicker: "Bot voices",
      title: provider.h1,
    })),
    ...BLOG_OG,
  ];
}

export function ogPublicPath(id: string): string {
  return `/og/${id}.png`;
}

export function blogOgId(slug: string): string {
  return `blog-${slug}`;
}
