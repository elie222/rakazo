import type { IntegrationPlatform } from "./types";
import {
  ARCADE,
  ARCADE_PRICING,
  COMPOSIO,
  COMPOSIO_PRICING,
  INTEGRATIONS_DOC,
  LARGE_TEAM,
  MERGE_PRICING,
  NANGO_PRICING,
  PIPEDREAM_PRICING,
  PRICES_CHECKED,
  PRICE_SUMMARY,
  SMALL_TEAM,
  WORKLOADS,
  ZAPIER,
  ZAPIER_PRICING,
  roundUsd,
  composioExtraCalls,
  composioHobby,
  composioPro,
  count,
  homepage,
  monthlyCalls,
  teamLabel,
  usd,
} from "./shared";

const SMALL = monthlyCalls(SMALL_TEAM);
const LARGE = monthlyCalls(LARGE_TEAM);
const FREE_CALLS = count(COMPOSIO.freeCalls);
const FREE_MANAGED = count(COMPOSIO.freeManagedCalls);
const PRO = usd(COMPOSIO.proFee);
const RATE = COMPOSIO.per1000;

export const composio: IntegrationPlatform = {
  slug: "composio",
  name: "Composio",
  gives: "Hosted app actions with sign-in handled",
  logins: "Composio stores them",
  bestFor: "A large app catalog with no OAuth apps to register",
  title: "Composio pricing, review and alternatives for AI agents (2026)",
  description:
    "What Composio is, what it costs per tool call in 2026, what a team of bots really spends, how it compares with Pipedream, Arcade and Zapier MCP, and how Rakazo bots use it.",
  h1: "Composio for AI agents: pricing, limits and alternatives",
  intro: [
    `[Composio](https://composio.dev) is a hosted service that gives AI agents actions in other apps, such as sending an email in Gmail or opening an issue in GitHub. It runs the sign-in for each app, stores the tokens, and calls the app's API when an agent asks it to. It is free up to ${FREE_CALLS} tool calls a month, and the paid plan starts at ${PRO} a month plus usage.`,
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and bots use tools in your apps as well as their own computer. When you host Rakazo yourself, one Composio API key fills the app catalog people connect from. Composio supplies the app actions and logins. Rakazo decides which account each bot acts as and asks you before anything that changes data.",
  ],
  scene: {
    bot: "Inbox Manager",
    color: "#6A6BF5",
    where: "Tools from Composio",
    ask: "sweep my inbox and put the follow-ups on my calendar. send nothing",
    reply: "on it. reading gmail now. calendar invites will wait for your ok.",
    results: [
      { k: "Gmail", v: "41 threads read" },
      { k: "Gmail", v: "6 replies drafted, not sent" },
      { k: "Google Calendar", v: "3 events waiting for approval" },
    ],
  },
  sections: [
    {
      heading: "What is Composio?",
      paragraphs: [
        `[Composio](https://composio.dev) is an integration platform for AI agents. It has a catalog of toolkits, one per app, each with actions an agent can call. Composio says it has ${COMPOSIO.toolkits} toolkits. It handles the OAuth sign-in and keeps the tokens encrypted, so the agent never sees a password or token. It also serves its tools over MCP for agents that speak that protocol, and offers triggers that fire when something happens in an app.`,
        "Its SDKs for TypeScript and Python are open source under the MIT license. The service behind them, including the app catalog and stored logins, is hosted by Composio. Running it in your own VPC or fully self-hosted is part of the Enterprise plan. Composio says it holds SOC 2 Type II and ISO 27001 certifications.",
      ],
      image: true,
    },
    {
      heading: "Composio pricing",
      paragraphs: [
        "Composio bills by tool call, and the price of a call depends on whose OAuth app it goes through. A **managed app** is one of Composio's own shared OAuth apps, so you skip registering anything with Google or Slack. Calls through your own OAuth app or API key, set up in Composio as a custom auth config, are much cheaper. Composio's FAQ says managed apps work in production but are not built for production scale, and suggests moving to your own app before you grow.",
      ],
      table: {
        caption: "Composio plans as of November 2026",
        columns: ["Plan", "Hobby", "Pro", "Enterprise"],
        rows: [
          { topic: "Price", cells: ["$0", `${PRO}/mo, as ${PRO} of usage credit`, "Custom, committed volume"] },
          {
            topic: "Tool calls included",
            cells: [`${FREE_CALLS}/mo, then usage stops`, `${FREE_CALLS}/mo, then billed`, "Custom"],
          },
          {
            topic: "Of those, on managed apps",
            cells: [`Up to ${FREE_MANAGED}`, `Up to ${FREE_MANAGED}`, "Custom"],
          },
          {
            topic: "Extra calls, your own app",
            cells: ["None, hard cap", `${usd(RATE.own)} per 1,000`, "Custom"],
          },
          {
            topic: "Extra calls, managed apps",
            cells: [
              "None, hard cap",
              `${usd(RATE.managed)} per 1,000 for most apps, ${usd(RATE.popular)} for apps like Gmail, Slack and HubSpot, ${usd(RATE.premium)} for apps like Salesforce and LinkedIn`,
              "Custom",
            ],
          },
          {
            topic: "Connected accounts",
            cells: [
              `Unlimited on your apps, ${count(COMPOSIO.freeManagedAccounts)} on managed apps`,
              `Unlimited on your apps; managed apps past ${count(COMPOSIO.freeManagedAccounts)} cost ${usd(COMPOSIO.extraManagedAccount)} once each`,
              "Custom",
            ],
          },
          {
            topic: "Rate limit",
            cells: [
              `${count(COMPOSIO.rateLimit.hobby)} requests/min`,
              `${count(COMPOSIO.rateLimit.pro)} requests/min`,
              "Custom",
            ],
          },
          { topic: "Team", cells: ["3 members", "Unlimited", "Unlimited, SSO and SCIM"] },
          {
            topic: "Compliance",
            cells: ["None listed", "Self-serve DPA; BAA and zero data retention as per-call add-ons", "MSA, DPA, BAA, customer-managed keys"],
          },
        ],
        note: `Prices from [Composio's pricing page](${COMPOSIO_PRICING}), checked ${PRICES_CHECKED}. The rates apply to sign-ups from August 15, 2026; earlier customers keep their old plan until December 31, 2026. Pro credit doesn't roll over.`,
      },
      bullets: [
        "Instant Tools, formerly Premium tools, call a paid third-party service such as a web search API with no account of your own. Composio passes on the provider's price with no markup, on top of the normal tool-call charge.",
        `Triggers are billed separately: ${usd(COMPOSIO.trigger.own)} per event on your own apps on Pro, and ${usd(COMPOSIO.trigger.managedLow)} to ${usd(COMPOSIO.trigger.managedHigh)} on managed apps after ${count(COMPOSIO.trigger.freeManaged)} free a month.`,
        "Pro has per-meter spend caps. The free plan never bills you; it pauses until the next month instead.",
        "Accepted startups get six months of Pro free through Composio's [startup program](https://composio.dev/startups).",
      ],
    },
    {
      heading: "What Rakazo bots cost on Composio",
      paragraphs: [
        `Rakazo uses Composio's managed apps unless you add your own auth config in Composio. ${WORKLOADS} Bots in Rakazo also search Composio's catalog for the right action; if every search counted as a call, double these numbers.`,
      ],
      table: {
        caption: "Monthly Composio bill for a team of Rakazo bots",
        columns: ["Workload", "Hobby", "Pro"],
        rows: [
          {
            topic: `${teamLabel(SMALL_TEAM)} on apps like Gmail and Slack`,
            cells: [composioHobby(SMALL, "popular"), usd(composioPro(SMALL, "popular"))],
          },
          {
            topic: `${teamLabel(LARGE_TEAM)} on apps like Gmail and Slack`,
            cells: [
              composioHobby(LARGE, "popular"),
              `About ${roundUsd(composioPro(LARGE, "popular"))}: ${count(composioExtraCalls(LARGE, "popular"))} extra calls at ${usd(RATE.popular)} per 1,000`,
            ],
          },
          {
            topic: `${teamLabel(LARGE_TEAM)} on apps like Salesforce`,
            cells: [
              composioHobby(LARGE, "premium"),
              `About ${roundUsd(composioPro(LARGE, "premium"))}: ${count(composioExtraCalls(LARGE, "premium"))} extra calls at ${usd(RATE.premium)} per 1,000`,
            ],
          },
          {
            topic: `${teamLabel(LARGE_TEAM)} through your own OAuth apps`,
            cells: [composioHobby(LARGE, "own"), usd(composioPro(LARGE, "own"))],
          },
        ],
        note: `Worked from [Composio's pricing page](${COMPOSIO_PRICING}), checked ${PRICES_CHECKED}. Model usage and the bots' computers are billed separately, by your model provider or by Rakazo.`,
      },
    },
    {
      heading: "Composio vs Pipedream and other alternatives",
      paragraphs: [
        `The pricing units differ, so compare a real workload, not the headline price. Composio charges per call and its free tier is the largest. [Pipedream Connect](/integration-platforms/pipedream/) charges per user and per 30 seconds of compute, and has no free production use. Zapier MCP spends ${ZAPIER.tasksPerCall} Zapier tasks per call. Arcade charges ${usd(ARCADE.perCall)} per call.`,
      ],
      table: {
        caption: "Composio and its main alternatives",
        columns: ["Option", "Free tier", "Paid from", "Billed by", "Apps", "Self-host", "In Rakazo"],
        rows: [
          {
            topic: "Composio",
            cells: [
              PRICE_SUMMARY.composio.free,
              PRICE_SUMMARY.composio.paid,
              PRICE_SUMMARY.composio.billedBy,
              PRICE_SUMMARY.composio.apps,
              "Enterprise only",
              "Built in: one API key",
            ],
          },
          {
            topic: "[Pipedream Connect](/integration-platforms/pipedream/)",
            cells: [
              PRICE_SUMMARY.pipedream.free,
              PRICE_SUMMARY.pipedream.paid,
              PRICE_SUMMARY.pipedream.billedBy,
              PRICE_SUMMARY.pipedream.apps,
              "No",
              "Built in: project and OAuth client",
            ],
          },
          {
            topic: "[Zapier MCP](https://zapier.com/mcp)",
            cells: [
              PRICE_SUMMARY.zapier.free,
              PRICE_SUMMARY.zapier.paid,
              PRICE_SUMMARY.zapier.billedBy,
              PRICE_SUMMARY.zapier.apps,
              "No",
              "As a remote MCP server",
            ],
          },
          {
            topic: `[Arcade](${ARCADE_PRICING})`,
            cells: [
              PRICE_SUMMARY.arcade.free,
              PRICE_SUMMARY.arcade.paid,
              PRICE_SUMMARY.arcade.billedBy,
              PRICE_SUMMARY.arcade.apps,
              "Enterprise only",
              "Not built in",
            ],
          },
          {
            topic: `[Merge Agent Handler](${MERGE_PRICING})`,
            cells: [
              PRICE_SUMMARY.merge.free,
              PRICE_SUMMARY.merge.paid,
              PRICE_SUMMARY.merge.billedBy,
              PRICE_SUMMARY.merge.apps,
              "Enterprise only",
              "Not built in",
            ],
          },
          {
            topic: `[Nango](${NANGO_PRICING})`,
            cells: [
              PRICE_SUMMARY.nango.free,
              PRICE_SUMMARY.nango.paid,
              PRICE_SUMMARY.nango.billedBy,
              PRICE_SUMMARY.nango.apps,
              "Enterprise only; source on GitHub",
              "Not built in",
            ],
          },
        ],
        note: `Prices from each provider's pricing page, checked ${PRICES_CHECKED}: [Composio](${COMPOSIO_PRICING}), [Pipedream](${PIPEDREAM_PRICING}), [Zapier](${ZAPIER_PRICING}), Arcade, Merge and Nango as linked.`,
      },
      bullets: [
        "**Pipedream Connect** is the closest match: another hosted catalog with managed logins, about twice as many apps, and SOC 2 Type 2 on every plan. It costs more at low volume and charges per user. Rakazo supports it too, and you can run both.",
        "**Zapier MCP** has the most apps and suits one person's own accounts. It signs in as the Zapier account that set it up, so every bot using it acts as that person.",
        "**Arcade** focuses on fewer, deeper toolkits and on authorization for each user. It is not built into Rakazo; its MCP gateways work only if their sign-in fits what Rakazo sends: OAuth, a bearer token or one custom header.",
        "**Nango** and **Paragon** are for software companies adding integrations to their own product. They are a poor fit for a team that just wants its bots in Gmail.",
        "**No middleman**: if an app publishes its own [MCP server](/integration-platforms/mcp/) or has an API key, connect it directly or with an [API connector](/integration-platforms/api-connectors/). You pay nothing extra.",
      ],
    },
    {
      heading: "Is Composio safe?",
      paragraphs: [
        "Composio keeps the OAuth tokens for every app your bots connect, so its security matters as much as Rakazo's. In May 2026 it [disclosed a breach](https://composio.dev/blog/composio-may-2026-security-incident): an attacker reached internal systems and took about 0.3% of active connections, almost all of them GitHub. A cache it likely reached held 5,241 API keys, which Composio revoked. Composio made every customer rotate their API keys within about two days and revoked the tokens it could.",
        "Since then, Composio says its APIs no longer return account tokens, OAuth credentials use envelope encryption, API keys are stored as hashes, and customers can restrict keys by IP address. Weigh that history against the alternatives, and keep [approvals](/docs/approvals/) on for actions that change data, whichever platform you choose.",
      ],
    },
    {
      heading: "What your bots can do with Composio",
      paragraphs: [
        "With Composio set up, the Apps list under Integrations shows Composio's catalog. Browse what is in it on the [integrations page](/integrations/), for example [Gmail](/integrations/gmail/), [Slack](/integrations/slack/), [GitHub](/integrations/github/), [Notion](/integrations/notion/) and [HubSpot](/integrations/hubspot/).",
      ],
      bullets: [
        "Connect an app in one step. Choose Connect under Integrations, or ask a bot to \"connect my Google Calendar\" and use the card it posts. You sign in on the app's own page through Composio.",
        "Share it across the space. Once an app is connected, every bot in that space can use it. You don't set it up per bot.",
        "Keep accounts apart. Rakazo pins each connection to the exact account you signed in with, so a bot never falls back to another mailbox or workspace. You can connect more than one account of the same app.",
        "Find the right action. Bots search Composio's actions and can run several in one batch.",
        "Ask before changes. [Approvals](/docs/approvals/) judge each action inside a batch on its own, so allowing one action never allows the rest.",
        "Run code on their own computer. Rakazo turns off Composio's hosted code sandbox in the sessions it creates, so you don't pay for sandbox runs.",
      ],
    },
    {
      heading: "When to choose Composio",
      paragraphs: [
        "Choose Composio when you self-host Rakazo and want a broad app catalog that works with a single API key, without registering an OAuth app with Google, Slack or anyone else. For a small team its free tier covers real use, which no other managed option here matches.",
        "Choose something else when you need production-grade sign-in for many people on apps billed at the top managed rate, when you can't send app tokens to a third party at all, or when the apps you need publish their own [MCP servers](/integration-platforms/mcp/). On [Rakazo Cloud](/pricing/) you don't need a Composio account: connecting apps is part of every plan. The [comparison](/integration-platforms/) puts every option side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Logins live with Composio, not on your server. Each tool call goes through Composio's service, so it has to be reachable.",
        "Some apps have no sign-in managed by Composio. Connecting one of them fails until you add your own auth config for it in Composio.",
        "The consent screen shows Composio unless you set up your own OAuth app in Composio.",
        "Managed apps share Composio's OAuth app, and each app's own rate limits still apply to it.",
        "Rakazo reads Composio's catalog once an hour, so newly added apps can take that long to appear.",
        "Composio is configured for the whole server. A space or user can't bring their own Composio key.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/). Rakazo Cloud users don't need a Composio account; they [connect apps](/docs/integrations/) from Integrations.",
      ],
      steps: [
        "Create an account at [composio.dev](https://composio.dev) and copy an API key.",
        "Set `COMPOSIO_API_KEY` on the Rakazo API and worker, then restart them.",
        "Open Integrations in Rakazo and check that the Apps catalog appears.",
        "Connect one app, such as Gmail, and ask a bot to read something from it.",
        "To cut costs or show your own name on the consent screen, add your own OAuth app for your busiest apps as a custom auth config in Composio.",
      ],
    },
  ],
  image: homepage(
    "composio",
    "Composio",
    "The Composio homepage, headed Give your AI secure access to skills in minutes.",
  ),
  faq: [
    {
      question: "How much does Composio cost?",
      answer:
        `As of ${PRICES_CHECKED}, the Hobby plan is free with ${FREE_CALLS} tool calls a month, up to ${FREE_MANAGED} of them on Composio's managed apps, and stops at that cap. Pro is ${PRO} a month, paid as usage credit, and bills extra calls at ${usd(RATE.own)} per 1,000 on your own apps and ${usd(RATE.managed)} to ${usd(RATE.premium)} per 1,000 on managed apps. Enterprise is custom. See [Composio's pricing page](${COMPOSIO_PRICING}).`,
    },
    {
      question: "Is Composio free?",
      answer:
        `Yes, for up to ${FREE_CALLS} tool calls a month, with no credit card. Only ${FREE_MANAGED} of those can go through Composio's managed OAuth apps, and the plan pauses at the cap rather than billing you.`,
    },
    {
      question: "Is Composio open source?",
      answer:
        "Partly. Composio's SDKs are on [GitHub](https://github.com/ComposioHQ/composio) under the MIT license. The hosted service that stores logins and runs actions is not, and self-hosting it is an Enterprise option. Rakazo uses that service through an API key.",
    },
    {
      question: "Is Composio safe to use?",
      answer:
        "Composio says it holds SOC 2 Type II and ISO 27001 certifications. In May 2026 it disclosed a breach that exposed some customer connections, mostly GitHub, and API keys, and it has since changed how it stores and returns credentials. Keep approvals on for actions that change data.",
    },
    {
      question: "Composio vs Pipedream: which is better for AI agents?",
      answer:
        "Both host app logins and give agents thousands of actions. Composio has the bigger free tier and bills per call. [Pipedream Connect](/integration-platforms/pipedream/) has more apps, bills per user and per 30 seconds of compute, and has no free production use. In Rakazo, Composio needs one API key and bots search its actions; Pipedream needs a project and OAuth client and serves each account's tools over its MCP server. You can turn on both.",
    },
    {
      question: "What are the best Composio alternatives?",
      answer:
        "[Pipedream Connect](/integration-platforms/pipedream/) is the closest. Zapier MCP has the most apps, Arcade focuses on per-user authorization, and Nango, which publishes its source, suits teams building integrations into a product. To skip a middleman, use the app's own [MCP server](/integration-platforms/mcp/) or an [API connector](/integration-platforms/api-connectors/).",
    },
    {
      question: "Does Rakazo need Composio?",
      answer:
        "No. Composio is optional. Without a managed provider, a self-hosted server shows no app catalog, but bots can still use [MCP servers](/integration-platforms/mcp/), OpenAPI and GraphQL [API connectors](/integration-platforms/api-connectors/), and plugins you add.",
    },
    {
      question: "Can a Rakazo bot send email through Composio without asking?",
      answer:
        "Only if you let it. In the Ask approval mode, the bot asks before any action that changes something, such as sending an email. You can allow a specific action for good or block it entirely in Settings → Approvals.",
    },
  ],
  sources: [
    { label: "Composio", href: "https://composio.dev" },
    { label: "Composio pricing", href: COMPOSIO_PRICING },
    { label: "Composio startup program", href: "https://composio.dev/startups" },
    { label: "Composio MCP gateway, compliance and deployment", href: "https://composio.dev/mcp-gateway" },
    {
      label: "Composio, May 2026 security incident",
      href: "https://composio.dev/blog/composio-may-2026-security-incident",
    },
    { label: "Composio SDKs on GitHub", href: "https://github.com/ComposioHQ/composio" },
    {
      label: "Composio, custom auth configs",
      href: "https://docs.composio.dev/docs/auth-configuration/custom-auth-configs",
    },
    { label: "Pipedream pricing", href: PIPEDREAM_PRICING },
    { label: "Zapier pricing", href: ZAPIER_PRICING },
    { label: "Arcade pricing", href: ARCADE_PRICING },
    { label: "Merge Agent Handler pricing", href: MERGE_PRICING },
    { label: "Nango pricing", href: NANGO_PRICING },
    INTEGRATIONS_DOC,
  ],
};
