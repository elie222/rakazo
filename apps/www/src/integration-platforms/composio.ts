import type { IntegrationPlatform } from "./types";
import { INTEGRATIONS_DOC, homepage } from "./shared";

export const composio: IntegrationPlatform = {
  slug: "composio",
  name: "Composio",
  gives: "Hosted app actions with sign-in handled",
  logins: "Composio stores them",
  bestFor: "A large app catalog with no OAuth apps to register",
  title: "Composio for AI agents: app tools for Rakazo bots, and alternatives",
  description:
    "What Composio is, and how Rakazo bots use it to work in Gmail, Slack, GitHub and more. Approvals, limits, setup, and how it compares with Pipedream and MCP.",
  h1: "Composio for AI agents: one key, a large app catalog",
  intro: [
    "[Composio](https://composio.dev) is a hosted service that gives AI agents actions in other apps, such as sending an email in Gmail or opening an issue in GitHub. It runs the sign-in for each app, stores the tokens, and calls the app's API when an agent asks it to.",
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
        "[Composio](https://composio.dev) is an integration platform for AI agents. It has a catalog of toolkits, one per app, each with actions an agent can call. Composio handles the OAuth sign-in and keeps the tokens encrypted, so the agent never sees a password or token.",
        "Its SDKs for TypeScript and Python are open source under the MIT license. The service behind them, including the app catalog and stored logins, is hosted by Composio. Composio also offers its tools over MCP for agents that speak that protocol.",
      ],
      image: true,
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
        "Run code on their own computer. Rakazo turns off Composio's hosted code sandbox in the sessions it creates.",
      ],
    },
    {
      heading: "When to choose Composio",
      paragraphs: [
        "Choose Composio when you self-host Rakazo and want a broad app catalog that works with a single API key, without registering an OAuth app with Google, Slack or anyone else.",
        "[Pipedream](/integration-platforms/pipedream/) is the other managed option. It also covers thousands of apps and hosts the logins, needs a project and OAuth client to set up, and gives bots its tools through its own MCP server. You can turn on both. To avoid a hosted middleman for a given app, add its [MCP server](/integration-platforms/mcp/) or point Rakazo at its API with an [API connector](/integration-platforms/api-connectors/). The [comparison](/integration-platforms/) puts all four side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Logins live with Composio, not on your server. Each tool call goes through Composio's service, so it has to be reachable.",
        "Some apps have no sign-in managed by Composio. Connecting one of them fails until you add your own auth config for it in Composio.",
        "The consent screen shows Composio unless you set up your own OAuth app in Composio.",
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
      question: "Is Composio open source?",
      answer:
        "Partly. Composio's SDKs are on [GitHub](https://github.com/ComposioHQ/composio) under the MIT license. The hosted service that stores logins and runs actions is not. Rakazo uses that service through an API key.",
    },
    {
      question: "Composio vs Pipedream for AI agents?",
      answer:
        "Both host app logins and give agents thousands of app actions. In Rakazo, Composio needs one API key, and bots search its actions and run them in batches. [Pipedream](/integration-platforms/pipedream/) needs a project and OAuth client, and serves each connected account's tools over its MCP server. Pipedream is owned by Workday.",
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
    {
      question: "What is a good Composio alternative?",
      answer:
        "[Pipedream Connect](/integration-platforms/pipedream/) is the closest: another hosted catalog with managed logins. If you'd rather not route app access through a third party, use the app's own [MCP server](/integration-platforms/mcp/) or an [API connector](/integration-platforms/api-connectors/).",
    },
  ],
  sources: [
    { label: "Composio", href: "https://composio.dev" },
    { label: "Composio SDKs on GitHub", href: "https://github.com/ComposioHQ/composio" },
    {
      label: "Composio, custom auth configs",
      href: "https://docs.composio.dev/docs/auth-configuration/custom-auth-configs",
    },
    INTEGRATIONS_DOC,
  ],
};
