import { absolute, articleMarkdown, cell, sectionMarkdown } from "../provider-article/markdown";
import type { ArticleHub, ArticleLink, ArticleSection } from "../provider-article/types";
import { SITE_URL } from "../site";
import { apiConnectors } from "./api-connectors";
import { composio } from "./composio";
import { mcp } from "./mcp";
import { pipedream } from "./pipedream";
import {
  ARCADE,
  ARCADE_PRICING,
  COMPOSIO,
  COMPOSIO_PRICING,
  INTEGRATIONS_DOCS_PATH,
  INTEGRATION_PLATFORMS_PATH,
  INTEGRATION_PLATFORMS_UPDATED,
  LARGE_TEAM,
  MERGE_PRICING,
  NANGO_PRICING,
  PARAGON_PRICING,
  PIPEDREAM,
  PIPEDREAM_PRICING,
  PRICES_CHECKED,
  PRICE_SUMMARY,
  SMALL_TEAM,
  WORKLOADS,
  ZAPIER,
  ZAPIER_PRICING,
  arcadeMonthly,
  composioHobby,
  composioPro,
  count,
  integrationPlatformPath,
  monthlyCalls,
  pipedreamMonthly,
  roundUsd,
  teamLabel,
  usd,
  zapierPlan,
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

const SMALL = monthlyCalls(SMALL_TEAM);
const LARGE = monthlyCalls(LARGE_TEAM);

function summaryCells(summary: { free: string; paid: string; billedBy: string; apps: string }) {
  return [summary.free, summary.paid, summary.billedBy, summary.apps];
}

function zapierCell(calls: number): string {
  const plan = zapierPlan(calls);
  return `${usd(plan.price)} billed yearly, for ${count(plan.tasks)} tasks`;
}

/** Comparison sections shown between the summary table and the cards. */
const HUB_SECTIONS: readonly ArticleSection[] = [
  {
    heading: "Pricing compared",
    paragraphs: [
      "On [Rakazo Cloud](/pricing/), connecting apps and MCP servers is part of every plan, and you don't need an account with any of these platforms. When you host Rakazo yourself, Rakazo is free and you pay any platform you turn on directly, on its own terms. The units differ, so the next table works out a real workload.",
    ],
    table: {
      caption: `Integration platforms for AI agents: prices as of ${PRICES_CHECKED}`,
      columns: ["Option", "Free tier", "Paid from", "Billed by", "Apps", "In Rakazo"],
      rows: [
        {
          topic: "[Composio](/integration-platforms/composio/)",
          cells: [...summaryCells(PRICE_SUMMARY.composio), "Built in"],
        },
        {
          topic: "[Pipedream Connect](/integration-platforms/pipedream/)",
          cells: [...summaryCells(PRICE_SUMMARY.pipedream), "Built in"],
        },
        {
          topic: "[An app's own MCP server](/integration-platforms/mcp/)",
          cells: ["Free with the app", "The app's plan", "Nothing extra", "Any app with a server", "Built in"],
        },
        {
          topic: "[API connectors](/integration-platforms/api-connectors/)",
          cells: [
            "Free in Rakazo",
            "The API's own price",
            "Nothing extra",
            "Any OpenAPI or GraphQL API",
            "Built in",
          ],
        },
        {
          topic: "Zapier MCP",
          cells: [...summaryCells(PRICE_SUMMARY.zapier), "As a remote MCP server"],
        },
        { topic: "Arcade", cells: [...summaryCells(PRICE_SUMMARY.arcade), "Not built in"] },
        {
          topic: "Merge Agent Handler",
          cells: [...summaryCells(PRICE_SUMMARY.merge), "Not built in"],
        },
        { topic: "Nango", cells: [...summaryCells(PRICE_SUMMARY.nango), "Not built in"] },
        {
          topic: "Paragon",
          cells: ["Trial", "Custom quote", "Connected customer", "Not stated", "Not built in"],
        },
      ],
      note: `Prices from each provider's pricing page, checked ${PRICES_CHECKED}: [Composio](${COMPOSIO_PRICING}), [Pipedream](${PIPEDREAM_PRICING}), [Zapier](${ZAPIER_PRICING}), [Arcade](${ARCADE_PRICING}), [Merge](${MERGE_PRICING}), [Nango](${NANGO_PRICING}) and [Paragon](${PARAGON_PRICING}).`,
    },
  },
  {
    heading: "What a team of bots costs on each",
    paragraphs: [
      `Two workloads. ${WORKLOADS} Calls go to everyday apps like Gmail and Slack, each finishes within 30 seconds, and everyone is in one space.`,
    ],
    table: {
      caption: `Monthly cost of ${count(SMALL)} and ${count(LARGE)} app actions`,
      columns: ["Option", teamLabel(SMALL_TEAM), teamLabel(LARGE_TEAM)],
      rows: [
        {
          topic: "An app's own MCP server or an API connector",
          cells: ["$0 beyond the apps' own plans", "$0 beyond the apps' own plans"],
        },
        {
          topic: "Composio, managed apps",
          cells: [
            `${composioHobby(SMALL, "popular")} on Hobby`,
            `About ${roundUsd(composioPro(LARGE, "popular"))} on Pro; ${roundUsd(composioPro(LARGE, "premium"))} if the calls go to apps like Salesforce`,
          ],
        },
        {
          topic: "Composio, your own OAuth apps",
          cells: [
            `${composioHobby(SMALL, "own")} on Hobby`,
            `${composioHobby(LARGE, "own")} on Hobby, or ${roundUsd(composioPro(LARGE, "own"))} on Pro`,
          ],
        },
        {
          topic: "Pipedream Connect",
          cells: [
            `${roundUsd(pipedreamMonthly(SMALL, SMALL_TEAM.people))} billed yearly`,
            `About ${roundUsd(pipedreamMonthly(LARGE, LARGE_TEAM.people))} billed yearly`,
          ],
        },
        { topic: "Zapier MCP", cells: [zapierCell(SMALL), zapierCell(LARGE)] },
        {
          topic: "Arcade",
          cells: [`About ${roundUsd(arcadeMonthly(SMALL))}`, `About ${roundUsd(arcadeMonthly(LARGE))}`],
        },
      ],
      note: `Worked from the pricing pages above, checked ${PRICES_CHECKED}. Arcade assumes no calls are included in the ${usd(ARCADE.fee)} fee, as its page lists none. Model usage and the bots' computers are separate costs.`,
    },
  },
  {
    heading: "Sign-in, self-hosting and compliance",
    paragraphs: [
      "A managed platform holds the OAuth tokens for every account your bots use, so who holds them matters. With MCP servers and API connectors, the grant or key is stored encrypted in your Rakazo and the model never sees it. With Composio, Pipedream or Zapier, it lives with them.",
    ],
    table: {
      caption: "Who holds the logins, and what you can run yourself",
      columns: ["Option", "OAuth app", "Source and self-hosting", "Compliance"],
      rows: [
        {
          topic: "Composio",
          cells: [
            "Composio's shared one, or your own as a custom auth config",
            "MIT SDKs; VPC or self-hosted on Enterprise",
            "SOC 2 Type II, ISO 27001",
          ],
        },
        {
          topic: "Pipedream Connect",
          cells: [
            "Pipedream's, or your own OAuth client",
            "Source-available; no self-hosting",
            "SOC 2 Type 2 on every plan; HIPAA on Business",
          ],
        },
        {
          topic: "MCP servers",
          cells: [
            "The app's; Rakazo registers itself or uses a client you enter",
            "Depends on the server; Rakazo is open source",
            "The app's own",
          ],
        },
        {
          topic: "API connectors",
          cells: ["None: an API key or token", "Rakazo is open source", "The API's own"],
        },
        {
          topic: "Zapier MCP",
          cells: ["Zapier's", "No", "SOC 2 Type II"],
        },
        {
          topic: "Arcade",
          cells: [
            "Arcade's, or your own",
            "MCP framework on GitHub; self-hosting on Enterprise",
            "Not on its pricing page",
          ],
        },
        {
          topic: "Nango",
          cells: ["Yours", "Source on GitHub; self-hosting on Enterprise", "SOC 2 Type 2"],
        },
      ],
      note: `From each provider's pricing and security pages, checked ${PRICES_CHECKED}. In May 2026 Composio [disclosed a breach](https://composio.dev/blog/composio-may-2026-security-incident) that exposed some stored connections, mostly GitHub, and has since changed how it stores credentials.`,
    },
  },
  {
    heading: "Alternatives that aren't built into Rakazo",
    paragraphs: [
      "Comparison articles often list these next to Composio and Pipedream. Here is what each is and how it fits with Rakazo.",
    ],
    bullets: [
      `**Zapier MCP** gives an MCP client actions in ${ZAPIER.apps} apps through your Zapier account. It speaks Streamable HTTP and signs in with OAuth, so it works in Rakazo as a remote [MCP server](/integration-platforms/mcp/). Every bot that uses it acts as the Zapier account that signed in, and each call spends ${ZAPIER.tasksPerCall} Zapier tasks.`,
      `**Arcade** is a hosted runtime for agent tools, with ${ARCADE.toolkits} toolkits and a focus on authorizing each user. Its MCP gateways work in Rakazo only if their sign-in fits what Rakazo sends: OAuth, a bearer token or one custom header.`,
      "**Nango** handles OAuth, syncs and tool calls for software companies building integrations into their own product, and publishes its source. It is a building block for developers, not a catalog a team connects to.",
      "**Paragon** and **Merge Agent Handler** serve the same product builders, with custom or high entry prices. A team that wants its own bots in Gmail and HubSpot doesn't need them.",
    ],
  },
];

export const INTEGRATION_PLATFORMS_HUB = {
  title:
    "Composio vs Pipedream vs MCP: integration platforms for AI agents compared, with pricing (2026)",
  description:
    "Composio, Pipedream Connect, MCP servers and API connectors compared on price, free tiers, app counts, OAuth and self-hosting, alongside Zapier MCP, Arcade and Nango, with what a team of bots costs on each.",
  h1: "Integration platforms for AI agents in 2026: pricing and comparison",
  intro: [
    "An AI agent is only as useful as the apps it can work in. To triage an inbox, update a CRM or file an issue, it needs tools for those apps and a safe way to sign in to them. There are a few ways to get there: a hosted platform that manages the logins for thousands of apps, an MCP server the app publishes itself, or a connector built straight from an API's description. For the same work, the price ranges from nothing beyond the app's own plan to hundreds of dollars a month.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and it uses your apps on your behalf, asking before it changes anything you've told it to check with you. Rakazo supports all four ways of giving bots tools, and you can mix them. This page compares them with the main alternatives, prices included. For the individual apps bots can use, see the [integrations catalog](/integrations/).",
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
  sections: HUB_SECTIONS,
  choose: [
    {
      heading: "You use Rakazo Cloud",
      text: "Connect apps from **Integrations** and add any MCP server or API you like. It is part of every [plan](/pricing/), and you don't need a Composio or Pipedream account. The choices below matter when you host Rakazo yourself.",
    },
    {
      heading: "The app has its own MCP server",
      text: "If the app publishes an MCP server, [connect it directly](/integration-platforms/mcp/): paste its URL or find it with Browse MCP servers, and sign in with OAuth. It costs nothing beyond the app, and no integration platform sits in between. On Rakazo Cloud, Rakazo stores the sign-in encrypted; when you host Rakazo yourself, it stays on your server. Anyone can add remote servers. Admins of a [self-hosted Rakazo](/self-hosted-ai-agent/) can also run local servers and reach internal ones.",
    },
    {
      heading: "The app only has an API",
      text: "If an app has an OpenAPI description or a GraphQL endpoint but no MCP server, an [API connector](/integration-platforms/api-connectors/) turns its operations into tools with just an API key, and you pay only the API's own price. There's no OAuth sign-in, so for apps that need one, use Composio or Pipedream.",
    },
    {
      heading: "You want a big app catalog with sign-in handled, cheaply",
      text: `[Composio](/integration-platforms/composio/) is the quickest way to give self-hosted bots a large app catalog: one API key, and Composio handles each app's sign-in. Its free tier covers a small team, and Pro starts at ${usd(COMPOSIO.proFee)} a month. Bots search its actions and run them in batches, and approvals judge each action on its own. Register your own OAuth apps for the busiest apps to cut the per-call price.`,
    },
    {
      heading: "You need more apps, or already use Pipedream",
      text: `[Pipedream Connect](/integration-platforms/pipedream/), owned by Workday, hosts logins for about twice as many apps and serves each connected account's tools over its MCP server, with SOC 2 Type 2 on every plan. It takes a project and an OAuth client to set up, and real users need the Startup plan at ${usd(PIPEDREAM.yearlyFee)} a month or more. It can run alongside Composio.`,
    },
    {
      heading: "You already pay for Zapier",
      text: `Add Zapier MCP as a remote [MCP server](/integration-platforms/mcp/). It reaches the most apps, but it acts as one Zapier account and each call spends ${ZAPIER.tasksPerCall} tasks, so it suits one person's bots more than a whole team's.`,
    },
    {
      heading: "You can't send app logins to a third party",
      text: "Host Rakazo yourself and use only MCP servers and API connectors. Grants and keys are stored encrypted on your server, and calls go straight from your server to each app.",
    },
  ],
  faq: [
    {
      question: "What is an integration platform for AI agents?",
      answer:
        "A service that gives an agent ready-made tools for other apps and handles signing in to them, so you don't build and host each integration yourself. Composio and Pipedream Connect are two examples. MCP servers and API connectors get you tools without a platform in the middle.",
    },
    {
      question: "Composio vs Pipedream: which is cheaper?",
      answer:
        `For most teams, Composio. As of ${PRICES_CHECKED} it is free up to ${count(COMPOSIO.freeCalls)} calls a month, ${count(COMPOSIO.freeManagedCalls)} of them on its managed apps, and Pro is ${usd(COMPOSIO.proFee)} a month plus per-call usage. Pipedream Connect has no free production use and starts at ${usd(PIPEDREAM.yearlyFee)} a month billed yearly, with ${usd(PIPEDREAM.perUser)} per user past ${PIPEDREAM.users} and ${usd(PIPEDREAM.perCredit)} per credit past ${count(PIPEDREAM.credits)}. For ${count(LARGE)} calls a month, that is roughly ${roundUsd(composioPro(LARGE, "popular"))} against ${roundUsd(pipedreamMonthly(LARGE, LARGE_TEAM.people))}.`,
    },
    {
      question: "What is MCP, and how is it different from an API?",
      answer:
        "The Model Context Protocol is an open standard that lets an AI application discover and call tools on a server. An API is how programs talk to a service. Most MCP servers sit in front of an API and describe part of it for a model. See [MCP servers](/integration-platforms/mcp/) for a full comparison.",
    },
    {
      question: "Is MCP free?",
      answer:
        "Yes. The protocol and its SDKs are open source. An app's own MCP server costs nothing beyond the app's plan; hosted gateways like Zapier MCP, Composio and Pipedream charge by use.",
    },
    {
      question: "Can I use Zapier MCP, Arcade or Nango with Rakazo?",
      answer:
        "Zapier MCP, yes, as a remote MCP server signed in with OAuth. Other hosted MCP gateways work if their sign-in is OAuth, a bearer token or one custom header. None of them is built in. Nango and Paragon are for building integrations into your own product, not for connecting a team's bots.",
    },
    {
      question: "Do I need Composio or Pipedream to use Rakazo?",
      answer:
        "No. Both are optional. Without them, bots can still use [MCP servers](/integration-platforms/mcp/), [API connectors](/integration-platforms/api-connectors/) and plugins you add. On a self-hosted server, the built-in app catalog appears once one of them is set up. On Rakazo Cloud, the catalog is there already.",
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
    ...hub.sections.flatMap(sectionMarkdown),
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
