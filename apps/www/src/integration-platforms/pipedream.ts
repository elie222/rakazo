import type { IntegrationPlatform } from "./types";
import {
  ARCADE,
  ARCADE_PRICING,
  COMPOSIO,
  COMPOSIO_PRICING,
  INTEGRATIONS_DOC,
  LARGE_TEAM,
  PIPEDREAM,
  PIPEDREAM_PRICING,
  PRICES_CHECKED,
  PRICE_SUMMARY,
  SMALL_TEAM,
  WORKLOADS,
  ZAPIER,
  ZAPIER_PRICING,
  composioPro,
  count,
  homepage,
  monthlyCalls,
  pipedreamExtraCredits,
  pipedreamMonthly,
  roundUsd,
  teamLabel,
  usd,
} from "./shared";

const SMALL = monthlyCalls(SMALL_TEAM);
const LARGE = monthlyCalls(LARGE_TEAM);
/** A company past the Startup plan's included users. */
const BIG_COMPANY = 150;
const YEARLY = usd(PIPEDREAM.yearlyFee);
const MONTHLY = usd(PIPEDREAM.monthlyFee);

export const pipedream: IntegrationPlatform = {
  slug: "pipedream",
  name: "Pipedream",
  gives: "Hosted app tools over Pipedream's MCP server",
  logins: "Pipedream stores them",
  bestFor: "Teams already on Pipedream Connect",
  title: "Pipedream Connect pricing, MCP server and alternatives for AI agents (2026)",
  description:
    "What Pipedream Connect and Pipedream MCP are, what Connect costs per user and credit in 2026, what a team of bots spends, how it compares with Composio, and how Rakazo bots use it.",
  h1: "Pipedream Connect for AI agents: pricing, MCP and alternatives",
  intro: [
    `[Pipedream Connect](https://pipedream.com/connect) is the part of Pipedream that lets AI agents act in other apps on behalf of each user. Pipedream runs the sign-in for each app, stores the tokens, and serves the app's actions as tools from a remote MCP server. Development is free; production starts at ${YEARLY} a month billed yearly. Pipedream is owned by Workday.`,
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and bots use tools in your apps as well as their own computer. When you host Rakazo yourself, a Pipedream Connect project can supply the apps people connect. Pipedream supplies the tools and logins. Rakazo picks which connected account each bot acts as and asks you before anything that changes data.",
  ],
  scene: {
    bot: "Account Manager",
    color: "#9B5CF6",
    where: "Tools from Pipedream",
    ask: "anything at risk before the renewals this month?",
    reply: "two accounts look shaky. I drafted notes for both, nothing posted yet.",
    results: [
      { k: "HubSpot", v: "12 renewals checked" },
      { k: "Zendesk", v: "2 accounts with open escalations" },
      { k: "Slack", v: "Summary waiting for approval" },
    ],
  },
  sections: [
    {
      heading: "What is Pipedream Connect?",
      paragraphs: [
        `[Pipedream](https://pipedream.com) started as a workflow automation tool. Workday bought it in a deal announced in November 2025, and Pipedream now focuses on Connect: managed sign-in for ${PIPEDREAM.apps} APIs, ${PIPEDREAM.tools} prebuilt actions and triggers, an API proxy for calls no action covers, and a remote MCP server that serves those actions to any MCP client.`,
        "Pipedream's Workflows product is in maintenance mode and shuts down on March 31, 2027. Pipedream says Connect, its MCP servers and the API proxy are not affected. The code for Pipedream's integrations is public on GitHub under its own source-available license, which bars competing commercial use, so it is not open source, and the service can't be self-hosted. Pipedream says every plan is covered by SOC 2 Type 2 and GDPR, with HIPAA on its Business plan.",
      ],
      image: true,
    },
    {
      heading: "What is Pipedream MCP?",
      paragraphs: [
        "Pipedream MCP is Pipedream's remote [MCP server](/integration-platforms/mcp/). Any MCP client, such as Claude, Cursor or an agent you build, can connect to it and get the actions for an app as tools. Pipedream identifies each end user with an external user ID, runs the sign-in for that user, and calls the app's API as them. It is included in every Connect plan, and each tool call is billed like any other action.",
        "Rakazo uses Pipedream through that server. It opens one MCP connection per connected account, so a person with two Gmail accounts gets two labeled sets of Gmail tools, and a bot can't mix them up.",
      ],
    },
    {
      heading: "Pipedream Connect pricing",
      paragraphs: [
        "Connect is billed on two meters: **external users**, the people your app connects accounts for, and **credits**. A credit buys 30 seconds of compute at the default 256 MB of memory, and running an action, an MCP tool call, a proxy request or a trigger event each uses at least one. Listing apps and accounts and other management calls are free. Most app actions finish well inside 30 seconds, so in practice one call is one credit; a slow call costs more.",
      ],
      table: {
        caption: "Pipedream Connect plans as of November 2026",
        columns: ["Plan", "Free", "Startup", "Business"],
        rows: [
          {
            topic: "Price",
            cells: ["$0", `${YEARLY}/mo billed yearly, or ${MONTHLY} monthly`, "Custom, yearly contract"],
          },
          {
            topic: "Production use",
            cells: ["No: development only", "Yes", "Yes"],
          },
          {
            topic: "External users",
            cells: [
              `${PIPEDREAM.devUsers} test users in development`,
              `${PIPEDREAM.users} included, then ${usd(PIPEDREAM.perUser)} per user a month`,
              "Volume pricing",
            ],
          },
          {
            topic: "Credits",
            cells: [
              "Development only",
              `${count(PIPEDREAM.credits)} a month, then ${usd(PIPEDREAM.perCredit)} each`,
              "Volume pricing",
            ],
          },
          {
            topic: "Apps and tools",
            cells: [`${PIPEDREAM.apps} apps, ${PIPEDREAM.tools} tools, MCP, proxy`, "Same", "Same"],
          },
          { topic: "Your own OAuth clients", cells: ["Yes", "Yes", "Yes"] },
          {
            topic: "Compliance",
            cells: ["SOC 2 Type 2, GDPR", "SOC 2 Type 2, GDPR", "Adds HIPAA, SSO, SCIM, static egress IPs"],
          },
          { topic: "Support", cells: ["Community", "Email", "SLA and a shared Slack channel"] },
        ],
        note: `Prices from [Pipedream's pricing page](${PIPEDREAM_PRICING}) and [Connect environments docs](https://pipedream.com/docs/connect/environments), checked ${PRICES_CHECKED}. A user counts once however many apps they connect.`,
      },
      bullets: [
        "The development environment is for your own testing. It allows 10 external users, and connecting an app only works in a browser signed in to pipedream.com, so it can't serve a team.",
        "Credits scale with memory: an action given 1 GB uses four credits per 30 seconds.",
        `Unlike Composio, there is no free production tier. The smallest real deployment is ${YEARLY} a month on a yearly plan.`,
      ],
    },
    {
      heading: "What Rakazo bots cost on Pipedream",
      paragraphs: [
        `Rakazo gives Pipedream one external user per person per space, so someone in two spaces counts as two users. The examples assume one space and calls that finish within 30 seconds. ${WORKLOADS}`,
      ],
      table: {
        caption: "Monthly Pipedream Connect bill for a team of Rakazo bots",
        columns: ["Workload", "Startup, billed yearly", "Startup, billed monthly"],
        rows: [
          {
            topic: teamLabel(SMALL_TEAM),
            cells: [
              `${usd(pipedreamMonthly(SMALL, SMALL_TEAM.people))}, inside the ${count(PIPEDREAM.credits)} credits`,
              usd(pipedreamMonthly(SMALL, SMALL_TEAM.people, "monthly")),
            ],
          },
          {
            topic: teamLabel(LARGE_TEAM),
            cells: [
              `About ${roundUsd(pipedreamMonthly(LARGE, LARGE_TEAM.people))}: ${YEARLY} plus ${count(pipedreamExtraCredits(LARGE))} credits at ${usd(PIPEDREAM.perCredit)}`,
              `About ${roundUsd(pipedreamMonthly(LARGE, LARGE_TEAM.people, "monthly"))}`,
            ],
          },
          {
            topic: `${BIG_COMPANY} people, the same ${count(LARGE)} calls`,
            cells: [
              `About ${roundUsd(pipedreamMonthly(LARGE, BIG_COMPANY))}: the above plus ${BIG_COMPANY - PIPEDREAM.users} users at ${usd(PIPEDREAM.perUser)}`,
              `About ${roundUsd(pipedreamMonthly(LARGE, BIG_COMPANY, "monthly"))}`,
            ],
          },
        ],
        note: `Worked from [Pipedream's pricing page](${PIPEDREAM_PRICING}), checked ${PRICES_CHECKED}. Model usage and the bots' computers are billed separately, by your model provider or by Rakazo.`,
      },
    },
    {
      heading: "Pipedream vs Composio",
      paragraphs: [
        "They do the same job in Rakazo: a hosted catalog with managed sign-in. The difference is mostly price shape and catalog size. [Composio](/integration-platforms/composio/) is free for real use at small volume and cheap per call; Pipedream has about twice as many apps, a fixed monthly floor, and a per-user charge that grows with your team.",
      ],
      table: {
        caption: "Pipedream Connect and Composio side by side",
        columns: ["Compared", "Pipedream Connect", "Composio"],
        rows: [
          { topic: "Apps", cells: [`${PIPEDREAM.apps} APIs, ${PIPEDREAM.tools} tools`, `${COMPOSIO.toolkits} toolkits`] },
          {
            topic: "Free tier",
            cells: [PRICE_SUMMARY.pipedream.free, PRICE_SUMMARY.composio.free],
          },
          { topic: "Paid from", cells: [`${YEARLY}/mo billed yearly`, PRICE_SUMMARY.composio.paid] },
          {
            topic: "Billed by",
            cells: ["External user and 30 s of compute", "Tool call, priced by app tier"],
          },
          {
            topic: teamLabel(LARGE_TEAM),
            cells: [
              `About ${roundUsd(pipedreamMonthly(LARGE, LARGE_TEAM.people))}/mo`,
              `About ${roundUsd(composioPro(LARGE, "popular"))} to ${roundUsd(composioPro(LARGE, "premium"))}/mo on managed apps, ${roundUsd(composioPro(LARGE, "own"))} on your own`,
            ],
          },
          {
            topic: "Managed OAuth",
            cells: ["Yes, or your own OAuth client", "Yes, or your own auth config"],
          },
          {
            topic: "Source and self-hosting",
            cells: ["Source-available, no self-hosting", "MIT SDKs; self-hosting on Enterprise"],
          },
          {
            topic: "Compliance",
            cells: ["SOC 2 Type 2 on every plan, HIPAA on Business", "SOC 2 Type II, ISO 27001; BAA as an add-on"],
          },
          { topic: "Owner", cells: ["Workday", "Independent"] },
          {
            topic: "Setup in Rakazo",
            cells: ["Project ID, OAuth client ID and secret", "One API key"],
          },
          {
            topic: "How bots get tools",
            cells: ["Pipedream's MCP server, one connection per account", "Search Composio's actions and run them in batches"],
          },
        ],
        note: `Prices from [Pipedream](${PIPEDREAM_PRICING}) and [Composio](${COMPOSIO_PRICING}), checked ${PRICES_CHECKED}.`,
      },
    },
    {
      heading: "Pipedream alternatives",
      bullets: [
        "**[Composio](/integration-platforms/composio/)** is the closest, built into Rakazo, and much cheaper for a small team.",
        `**Zapier MCP** reaches ${ZAPIER.apps} apps and spends ${ZAPIER.tasksPerCall} Zapier tasks per call; the free plan's ${ZAPIER.freeTasks} tasks cover about ${ZAPIER.freeTasks / ZAPIER.tasksPerCall} calls and paid plans start at ${usd(ZAPIER.pro[0].price)} a month billed yearly ([pricing](${ZAPIER_PRICING})). It isn't built into Rakazo, but you can add it as a remote [MCP server](/integration-platforms/mcp/). It acts as the Zapier account that set it up.`,
        `**Arcade** charges ${usd(ARCADE.fee)} a month plus ${usd(ARCADE.perCall)} a call and focuses on authorization for each user. **Nango** publishes its source and suits teams adding integrations to their own product. Neither is built into Rakazo.`,
        "**For Pipedream Workflows users**: Connect is not an automation builder. If you need scheduled workflows rather than tools for agents, look at n8n, Make or Windmill, or give a Rakazo bot a [routine](/docs/routines/).",
        "**No middleman**: an app's own [MCP server](/integration-platforms/mcp/) or an [API connector](/integration-platforms/api-connectors/) adds no fee on top of the app.",
      ],
    },
    {
      heading: "What your bots can do with Pipedream",
      paragraphs: [
        "With Pipedream set up, the Apps list under Integrations shows every Pipedream app that has actions. Many are also in the catalog on the [integrations page](/integrations/), such as [HubSpot](/integrations/hubspot/), [Slack](/integrations/slack/), [Zendesk](/integrations/zendesk/), [Google Sheets](/integrations/googlesheets/) and [Jira](/integrations/jira/).",
      ],
      bullets: [
        "Connect an app on Pipedream's page. Choose Connect under Integrations, or ask a bot to connect it and use the card it posts. Pipedream's Connect Link opens for that app and you sign in there.",
        "Share it across the space. Once an app is connected, every bot in that space can use it.",
        "Use more than one account of the same app. Each connected account gets its own set of tools, labeled with the account. If that account goes away, Rakazo stops instead of using another one.",
        "Keep the tool list short. When the connected apps add up to more than 20 tools, bots get a searchable list instead of every tool up front.",
        "Ask before changes. Pipedream tools follow your [approval settings](/docs/approvals/) like any other tool.",
        "Keep identities private. Pipedream sees an opaque ID for each person and space, not their name or email.",
      ],
    },
    {
      heading: "When to choose Pipedream",
      paragraphs: [
        "Choose Pipedream when you self-host Rakazo and already use Pipedream Connect, need an app only Pipedream covers, or want SOC 2 coverage without an enterprise contract. Its tools reach Rakazo through Pipedream's own MCP server, one connection per account.",
        "[Composio](/integration-platforms/composio/) is the other managed option and the simpler one to set up: a single API key. You can run both, and the Apps list shows apps from each. On [Rakazo Cloud](/pricing/) you don't need a Pipedream account: connecting apps is part of every plan. For an app that publishes its own [MCP server](/integration-platforms/mcp/), or one you can reach with an [API connector](/integration-platforms/api-connectors/), you don't need a hosted middleman at all. The [comparison](/integration-platforms/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        `Pipedream's development environment is for testing with your own accounts. It allows ${PIPEDREAM.devUsers} users, and connecting an app only works in a browser signed in to pipedream.com. Rakazo uses development unless you set production, which needs a Connect plan from Pipedream.`,
        "Rakazo derives each person's Pipedream ID from `ENCRYPTION_KEY`. Change that key and existing Pipedream connections are orphaned and must be connected again.",
        "Logins live with Pipedream, not on your server, and every tool call goes through Pipedream's service.",
        "Pipedream is configured for the whole server. A space or user can't bring their own project.",
        "Rakazo refreshes Pipedream's app list every 10 minutes.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/). Rakazo Cloud users don't need a Pipedream account; they [connect apps](/docs/integrations/) from Integrations.",
      ],
      steps: [
        "In [Pipedream](https://pipedream.com), create a project and an OAuth client for its API. Copy the client ID, client secret and project ID.",
        "Set `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` and `PIPEDREAM_PROJECT_ID` on the Rakazo API and worker.",
        "Set `PIPEDREAM_ENVIRONMENT` to `development` to test, or `production` for real users, then restart the API and worker.",
        "Open Integrations in Rakazo, connect one app, and ask a bot to read something from it.",
      ],
    },
  ],
  image: homepage(
    "pipedream",
    "Pipedream",
    "The Pipedream homepage, headed The integration layer for AI agents.",
  ),
  faq: [
    {
      question: "How much does Pipedream Connect cost?",
      answer:
        `As of ${PRICES_CHECKED}, development is free. Production needs the Startup plan: ${YEARLY} a month billed yearly or ${MONTHLY} monthly, with ${PIPEDREAM.users} external users and ${count(PIPEDREAM.credits)} credits, then ${usd(PIPEDREAM.perUser)} per extra user and ${usd(PIPEDREAM.perCredit)} per extra credit. A credit is 30 seconds of compute. Business is custom. See [Pipedream's pricing page](${PIPEDREAM_PRICING}).`,
    },
    {
      question: "Is Pipedream free?",
      answer:
        `Only for development: up to ${PIPEDREAM.devUsers} test users, each connecting from a browser signed in to pipedream.com. Serving real users needs a paid plan.`,
    },
    {
      question: "What is Pipedream MCP?",
      answer:
        "Pipedream's remote MCP server. It serves the actions for each app a user has connected as MCP tools, with Pipedream handling sign-in. It is included in every Connect plan, and each tool call uses credits. Rakazo connects to it once per connected account.",
    },
    {
      question: "Is Pipedream shutting down?",
      answer:
        "Pipedream Workflows and String shut down on March 31, 2027. Pipedream says Connect, its MCP servers and the API proxy are unaffected and still developed, and those are what Rakazo uses.",
    },
    {
      question: "Is Pipedream open source?",
      answer:
        "No. Pipedream's integration code is public on [GitHub](https://github.com/PipedreamHQ/pipedream) under the Pipedream Source Available License, which forbids competing commercial use. The hosted service is closed. Rakazo uses it through your project's credentials.",
    },
    {
      question: "Pipedream vs Composio for AI agents?",
      answer:
        `Both host app logins and give agents thousands of actions. Pipedream has more apps and bills per user and per 30 seconds of compute, from ${YEARLY} a month. [Composio](/integration-platforms/composio/) bills per call and is free up to ${count(COMPOSIO.freeCalls)} calls. In Rakazo, Composio takes one API key and bots search its actions; Pipedream takes a project and OAuth client and serves each account's tools over its MCP server. You can turn on both.`,
    },
    {
      question: "What is a good Pipedream alternative?",
      answer:
        "[Composio](/integration-platforms/composio/) for agents, which Rakazo also supports. Zapier MCP for the largest catalog, which works in Rakazo as a remote MCP server. For workflow automation rather than agent tools, n8n, Make or Windmill.",
    },
    {
      question: "Who owns Pipedream?",
      answer:
        "Workday. It announced the deal in November 2025 and reported it closed in its February 2026 results.",
    },
    {
      question: "Does Rakazo need Pipedream?",
      answer:
        "No. Pipedream is optional. Bots can use [Composio](/integration-platforms/composio/), [MCP servers](/integration-platforms/mcp/) or [API connectors](/integration-platforms/api-connectors/) instead, or alongside it.",
    },
  ],
  sources: [
    { label: "Pipedream Connect", href: "https://pipedream.com/connect" },
    { label: "Pipedream pricing", href: PIPEDREAM_PRICING },
    {
      label: "Pipedream, Connect environments",
      href: "https://pipedream.com/docs/connect/environments",
    },
    { label: "Pipedream, Workflows shutdown notice", href: "https://pipedream.com/docs/workflows" },
    { label: "Pipedream on GitHub", href: "https://github.com/PipedreamHQ/pipedream" },
    {
      label: "Workday, fourth quarter fiscal 2026 results",
      href: "https://www.sec.gov/Archives/edgar/data/1327811/000132781126000010/wday-01312026x991.htm",
    },
    { label: "Composio pricing", href: COMPOSIO_PRICING },
    { label: "Zapier pricing", href: ZAPIER_PRICING },
    { label: "Zapier MCP", href: "https://zapier.com/mcp" },
    { label: "Arcade pricing", href: ARCADE_PRICING },
    INTEGRATIONS_DOC,
  ],
};
