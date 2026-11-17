import { getHomeCopy, HOME_CHANNELS, HOME_FEATURE_KINDS, HOME_MODEL_PROVIDERS } from "./i18n/home";
import { DEFAULT_LOCALE, isLocale } from "./i18n/locales";
import { APP_URL } from "./site";

export const AGENT_DISCOVERY_LINKS =
  '</llms.txt>; rel="describedby"; type="text/plain", </.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/ai-catalog+json"';

const home = getHomeCopy("en");

export const HOME_MARKDOWN = `# Rakazo

${home.hero.eyebrow}

${home.hero.lead}

## ${home.roster.heading}

${home.roster.copy}

${home.roster.bots.map((bot) => `- **${bot.name}:** ${bot.desc}`).join("\n")}

## ${home.channels.heading}

${home.channels.copy}

${HOME_CHANNELS.map((channel) => `- ${channel.name}${channel.selfHosted ? ` (${home.selfHost.heading})` : ""}`).join("\n")}

## ${home.features.heading}

${HOME_FEATURE_KINDS.map((kind) => `- **${home.features.items[kind].title}:** ${home.features.items[kind].body}`).join("\n")}

## ${home.testimonials.heading}

${home.testimonials.items.map((item) => `> ${item.quote}\n>\n> — ${item.attribution}`).join("\n\n")}

## ${home.selfHost.heading}

${home.selfHost.copy}

${home.selfHost.features.map((feature) => `- **${feature.title}:** ${feature.body}`).join("\n")}

${home.selfHost.worksWith}: ${HOME_MODEL_PROVIDERS.join(", ")}.

## ${home.openSource.heading}

${home.openSource.copy}

[${home.openSource.cloudTitle}](${APP_URL}): ${home.openSource.cloudBadge}.

## FAQ

${getHomeCopy("en")
  .faq.items.map((item) => `### ${item.question}\n\n${item.answer}`)
  .join("\n\n")}

## ${home.cta.heading}

${home.cta.copy}

- [Agent setup prompt](https://github.com/elie222/rakazo/blob/main/SETUP_PROMPT.md)
- [Self-hosting guide](https://rakazo.com/self-hosted-ai-agent/)
- [Full self-hosting reference](https://github.com/elie222/rakazo/blob/main/docs/self-host.md)
- [OpenClaw comparison](https://rakazo.com/openclaw-alternative/)
- [Source code](https://github.com/elie222/rakazo)

## Site index

- [Agent instructions](https://rakazo.com/llms.txt)
- [Self-hosted AI agent](https://rakazo.com/self-hosted-ai-agent/)
- [OpenClaw comparison](https://rakazo.com/openclaw-alternative/)
- [Alternatives](https://rakazo.com/alternatives/)
- [Docs](https://rakazo.com/docs/)
- [Integrations](https://rakazo.com/integrations/)
- [Sandboxes for AI agents](https://rakazo.com/sandboxes/)
- [Integration platforms for AI agents](https://rakazo.com/integration-platforms/)
- [Voice providers for AI agents](https://rakazo.com/voice-providers/)
- [Blog](https://rakazo.com/blog/)
- [Grok Bot alternatives](https://rakazo.com/grok-bot-alternative/)
- [Pricing](https://rakazo.com/pricing/): free to self-host, or hosted with your own model or Rakazo credits.
- [Enterprise](https://rakazo.com/enterprise/): SSO, SCIM, audit log, encryption at rest, and approval rules on your own infrastructure.
- [Download](https://rakazo.com/download/): desktop, mobile, and web apps.
- [About](https://rakazo.com/about/)
- [Brand](https://rakazo.com/brand/)
- [Support](https://rakazo.com/support/)
- [Privacy](https://rakazo.com/privacy/)
- [Terms](https://rakazo.com/terms/)
- [Sitemap](https://rakazo.com/sitemap-index.xml)
`;

export const NOT_FOUND_MARKDOWN = `# Page not found

The requested Rakazo page does not exist.

- [Agent instructions](https://rakazo.com/llms.txt)
- [Site map](https://rakazo.com/sitemap-index.xml)
- [Home](https://rakazo.com/)
- [Self-hosting guide](https://rakazo.com/self-hosted-ai-agent/)
`;

type MediaPreference = {
  quality: number;
  specificity: number;
};

export type Representation = "html" | "markdown";

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function preferenceFor(accept: string, desiredType: string): MediaPreference {
  const [desiredMajor, desiredMinor] = desiredType.split("/");
  let best: MediaPreference = { quality: 0, specificity: -1 };

  for (const rawRange of accept.split(",")) {
    const [rawType = "", ...rawParameters] = rawRange.trim().toLowerCase().split(";");
    const [major, minor] = rawType.trim().split("/");
    if (!major || !minor) continue;

    const specificity =
      major === desiredMajor && minor === desiredMinor
        ? 2
        : major === desiredMajor && minor === "*"
          ? 1
          : major === "*" && minor === "*"
            ? 0
            : -1;
    if (specificity < 0) continue;

    const qualityParameter = rawParameters.find((parameter) => parameter.trim().startsWith("q="));
    const parsedQuality = qualityParameter
      ? Number.parseFloat(qualityParameter.trim().slice(2))
      : 1;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;

    if (
      specificity > best.specificity ||
      (specificity === best.specificity && quality > best.quality)
    ) {
      best = { quality, specificity };
    }
  }

  return best;
}

export function negotiateRepresentation(acceptHeader: string | null): Representation {
  if (!acceptHeader?.trim()) return "html";

  const markdown = preferenceFor(acceptHeader, "text/markdown");
  const html = preferenceFor(acceptHeader, "text/html");

  if (markdown.quality > html.quality) return "markdown";
  if (
    markdown.quality > 0 &&
    markdown.quality === html.quality &&
    markdown.specificity > html.specificity
  )
    return "markdown";
  return "html";
}

/** Pages built without a Markdown twin: translations, which share the English one, and claim forms. */
function hasNoTwin(pathname: string): boolean {
  const [, first] = pathname.split("/");
  return (
    (first !== DEFAULT_LOCALE && isLocale(first)) || /^\/integrations\/[^/]+\/claim$/.test(pathname)
  );
}

/** The path of a page's Markdown twin, which every other page has beside its HTML. */
export function getMarkdownAlternate(pathname: string): string | undefined {
  const normalizedPathname = normalizePathname(pathname);
  if (normalizedPathname === "/") return "/index.md";
  // A path such as `//host/x` would name another origin once resolved as a URL.
  if (!/^\/[^/\\]/.test(normalizedPathname) || normalizedPathname.includes("\\")) return undefined;
  return hasNoTwin(normalizedPathname) ? undefined : `${normalizedPathname}.md`;
}

export function markdownResponse(body: string, method = "GET", status = 200): Response {
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "en",
      "Content-Type": "text/markdown; charset=utf-8",
      Link: AGENT_DISCOVERY_LINKS,
      Vary: "Accept, Accept-Encoding",
      ...(status === 404 ? { "X-Robots-Tag": "noindex" } : {}),
    },
  });
}
