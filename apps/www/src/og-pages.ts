import { ALTERNATIVES, ALTERNATIVES_HUB } from "./alternatives";
import { GROK_ALTERNATIVE_H1 } from "./grok-alternative";
import { OPENCLAW_H1 } from "./guide";

export type OgPage = {
  id: string;
  kicker: string;
  title: string;
};

const BLOG_OG: readonly OgPage[] = [
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
    { id: "grok-bot-alternative", kicker: "Comparison", title: GROK_ALTERNATIVE_H1 },
    { id: "openclaw-alternative", kicker: "Comparison", title: OPENCLAW_H1 },
    {
      id: "self-hosted-ai-agent",
      kicker: "Guide",
      title: "Self-hosted AI agent",
    },
    ...BLOG_OG,
  ];
}

export function ogPublicPath(id: string): string {
  return `/og/${id}.png`;
}

export function blogOgId(slug: string): string {
  return `blog-${slug}`;
}
