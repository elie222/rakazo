import { absolute, articleMarkdown, cell } from "../provider-article/markdown";
import type { ArticleHub, ArticleLink } from "../provider-article/types";
import { SITE_URL } from "../site";
import { apiConnectors } from "./api-connectors";
import { composio } from "./composio";
import { mcp } from "./mcp";
import { pipedream } from "./pipedream";
import {
  INTEGRATIONS_DOCS_PATH,
  INTEGRATION_PLATFORMS_PATH,
  INTEGRATION_PLATFORMS_UPDATED,
  integrationPlatformPath,
} from "./shared";
import type { IntegrationPlatform } from "./types";

export * from "./shared";
export type { IntegrationPlatform } from "./types";

/** Display order everywhere integration platforms are listed. */
export const INTEGRATION_PLATFORMS: readonly IntegrationPlatform[] = [
  composio,
  pipedream,
  mcp,
  apiConnectors,
];

export const INTEGRATION_PLATFORMS_HUB = {
  title:
    "Best integration platforms for AI agents in 2026: Composio, Pipedream, MCP servers and API connectors",
  description:
    "How should an AI agent get tools for Gmail, GitHub or your own API? Composio, Pipedream, MCP servers and OpenAPI or GraphQL connectors compared, from the team behind Rakazo.",
  h1: "Integration platforms for AI agents in 2026",
  intro: [
    "An AI agent is only as useful as the apps it can work in. To triage an inbox, update a CRM or file an issue, it needs tools for those apps and a safe way to sign in to them. There are a few ways to get there: a hosted platform that manages the logins for thousands of apps, an MCP server the app publishes itself, or a connector built straight from an API's description.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and it uses your apps on your behalf, asking before it changes anything you've told it to check with you. Rakazo supports all four ways of giving bots tools, and you can mix them. This page compares them. For the individual apps bots can use, see the [integrations catalog](/integrations/).",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Tools from your apps",
    ask: "prep me for tomorrow's offsite call",
    reply: "pulled it together from your calendar, the crm and the venue thread. nothing sent.",
    results: [
      { k: "Calendar", v: "2 conflicts moved" },
      { k: "HubSpot", v: "4 open deals summarized" },
      { k: "Gmail", v: "venue reply drafted, waiting for you" },
    ],
  },
  choose: [
    {
      heading: "You want a big app catalog with sign-in handled",
      text: "[Composio](/integration-platforms/composio/) is the quickest way to give self-hosted bots a large app catalog: one API key, and Composio handles each app's sign-in. Bots search its actions and run them in batches, and approvals judge each action on its own.",
    },
    {
      heading: "You already use Pipedream",
      text: "[Pipedream Connect](/integration-platforms/pipedream/), owned by Workday, also hosts logins for thousands of apps and serves each connected account's tools over its MCP server. It takes a project and an OAuth client to set up, and needs its production environment for more than a handful of users. It can run alongside Composio.",
    },
    {
      heading: "The app has its own MCP server",
      text: "If the app publishes an MCP server, [connect it directly](/integration-platforms/mcp/): paste its URL or find it with Browse MCP servers, and sign in with OAuth. Anyone can add remote servers. Admins of a [self-hosted Rakazo](/self-hosted-ai-agent/) can also run local servers and reach internal ones.",
    },
    {
      heading: "The app only has an API",
      text: "If an app has an OpenAPI description or a GraphQL endpoint but no MCP server, an [API connector](/integration-platforms/api-connectors/) turns its operations into tools with just an API key. There's no OAuth sign-in, so for apps that need one, use Composio or Pipedream.",
    },
  ],
  faq: [
    {
      question: "What is an integration platform for AI agents?",
      answer:
        "A service that gives an agent ready-made tools for other apps and handles signing in to them, so you don't build and host each integration yourself. Composio and Pipedream Connect are two examples. MCP servers and API connectors get you tools without a platform in the middle.",
    },
    {
      question: "Do I need Composio or Pipedream to use Rakazo?",
      answer:
        "No. Both are optional. Without them, bots can still use [MCP servers](/integration-platforms/mcp/), [API connectors](/integration-platforms/api-connectors/) and plugins you add. On a self-hosted server, the built-in app catalog appears once one of them is set up.",
    },
    {
      question: "Can I use more than one?",
      answer:
        "Yes. A self-hosted server can have Composio and Pipedream on together, and the Apps list shows apps from both. MCP servers and API connectors work alongside either.",
    },
    {
      question: "Does the AI model see my app logins?",
      answer:
        "No. OAuth grants, tokens and API keys are stored encrypted, added to requests by the server, and never sent to the model. Hosted platforms like Composio and Pipedream keep the logins they manage on their side.",
    },
  ],
};

export const INTEGRATION_PLATFORMS_ARTICLE_HUB: ArticleHub = {
  label: "Integration platforms for AI agents",
  compareLabel: "Compare all integration platforms",
  href: INTEGRATION_PLATFORMS_PATH,
  moreHeading: "More ways to give AI agents tools",
  guide: { label: "Tools and integrations guide", href: INTEGRATIONS_DOCS_PATH },
};

export function integrationPlatformLink(platform: IntegrationPlatform): ArticleLink {
  return {
    name: platform.name,
    href: integrationPlatformPath(platform.slug),
    meta: platform.bestFor,
    image: platform.image,
  };
}

export function otherIntegrationPlatforms(platform: IntegrationPlatform): ArticleLink[] {
  return INTEGRATION_PLATFORMS.filter((other) => other.slug !== platform.slug).map(
    integrationPlatformLink,
  );
}

/** Markdown twin of an integration platform page, for agents and `.md` requests. */
export function integrationPlatformMarkdown(platform: IntegrationPlatform): string {
  return articleMarkdown(platform, {
    hub: INTEGRATION_PLATFORMS_ARTICLE_HUB,
    others: otherIntegrationPlatforms(platform),
    updated: INTEGRATION_PLATFORMS_UPDATED,
  });
}

/** Markdown twin of the integration platforms hub. */
export function integrationPlatformsHubMarkdown(): string {
  const hub = INTEGRATION_PLATFORMS_HUB;
  return [
    `# ${hub.h1}`,
    "",
    ...hub.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${INTEGRATION_PLATFORMS_UPDATED}.`,
    "",
    "## Compared",
    "",
    "| Option | Gives bots | App logins | Best for |",
    "| --- | --- | --- | --- |",
    ...INTEGRATION_PLATFORMS.map(
      (platform) =>
        `| [${cell(platform.name)}](${SITE_URL}${integrationPlatformPath(platform.slug)}) | ${cell(platform.gives)} | ${cell(platform.logins)} | ${cell(platform.bestFor)} |`,
    ),
    "",
    "## How to choose",
    "",
    ...hub.choose.flatMap((item) => [`### ${item.heading}`, "", absolute(item.text), ""]),
    `[Tools and integrations guide](${SITE_URL}${INTEGRATIONS_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...hub.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
  ].join("\n");
}
