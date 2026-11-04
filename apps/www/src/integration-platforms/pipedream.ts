import type { IntegrationPlatform } from "./types";
import { INTEGRATIONS_DOC, homepage } from "./shared";

export const pipedream: IntegrationPlatform = {
  slug: "pipedream",
  name: "Pipedream",
  gives: "Hosted app tools over Pipedream's MCP server",
  logins: "Pipedream stores them",
  bestFor: "Teams already on Pipedream Connect",
  title: "Pipedream Connect for AI agents: app tools for Rakazo bots",
  description:
    "What Pipedream Connect is, and how Rakazo bots use it to work in thousands of apps through its MCP server. Approvals, limits, setup, and how it compares with Composio.",
  h1: "Pipedream Connect for AI agents: app tools with hosted logins",
  intro: [
    "[Pipedream Connect](https://pipedream.com/connect) is the part of Pipedream that lets AI agents act in other apps on behalf of each user. Pipedream runs the sign-in for each app, stores the tokens, and serves the app's actions as tools from a remote MCP server. Pipedream is owned by Workday.",
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
        "[Pipedream](https://pipedream.com) started as a workflow automation tool. Workday bought it in a deal announced in November 2025, and Pipedream now focuses on Connect: managed sign-in, prebuilt actions for thousands of APIs, an API proxy, and a remote MCP server that serves those actions to any MCP client.",
        "Pipedream's Workflows product is in maintenance mode and shuts down on March 31, 2027. Pipedream says Connect, its MCP servers and the API proxy are not affected. The code for Pipedream's integrations is public on GitHub under its own source-available license, which bars competing commercial use, so it is not open source.",
      ],
      image: true,
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
        "Choose Pipedream when you self-host Rakazo and already use Pipedream Connect, or want its catalog of apps and prebuilt actions. Its tools reach Rakazo through Pipedream's own MCP server, one connection per account.",
        "[Composio](/integration-platforms/composio/) is the other managed option and the simpler one to set up: a single API key. You can run both, and the Apps list shows apps from each. For an app that publishes its own [MCP server](/integration-platforms/mcp/), or one you can reach with an [API connector](/integration-platforms/api-connectors/), you don't need a hosted middleman at all. The [comparison](/integration-platforms/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Pipedream's development environment is for testing with your own accounts. It allows 10 users, and connecting an app only works in a browser signed in to pipedream.com. Rakazo uses development unless you set production, which needs a Connect plan from Pipedream.",
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
      question: "Is Pipedream open source?",
      answer:
        "No. Pipedream's integration code is public on [GitHub](https://github.com/PipedreamHQ/pipedream) under the Pipedream Source Available License, which forbids competing commercial use. The hosted service is closed. Rakazo uses it through your project's credentials.",
    },
    {
      question: "Is Pipedream shutting down?",
      answer:
        "Pipedream Workflows and String shut down on March 31, 2027. Pipedream says Connect, its MCP servers and the API proxy are unaffected and still developed, and those are what Rakazo uses.",
    },
    {
      question: "Pipedream vs Composio for AI agents?",
      answer:
        "Both host app logins and give agents thousands of actions. In Rakazo, [Composio](/integration-platforms/composio/) takes one API key and bots search its actions. Pipedream takes a project and OAuth client, and serves each connected account's tools over its MCP server. You can turn on both.",
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
    INTEGRATIONS_DOC,
  ],
};
