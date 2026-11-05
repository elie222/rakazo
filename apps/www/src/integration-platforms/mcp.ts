import { GITHUB_URL } from "../site";
import {
  COMPOSIO,
  COMPOSIO_PRICING,
  INTEGRATIONS_DOC,
  PIPEDREAM,
  PIPEDREAM_PRICING,
  PRICES_CHECKED,
  ZAPIER,
  ZAPIER_PRICING,
  count,
  homepage,
  usd,
} from "./shared";
import type { IntegrationPlatform } from "./types";

export const mcp: IntegrationPlatform = {
  slug: "mcp",
  name: "MCP servers",
  gives: "Tools from any MCP server, remote or local",
  logins: "Your OAuth grant or token, encrypted in Rakazo",
  bestFor: "Apps that publish their own MCP server",
  title: "What is MCP? MCP servers explained, MCP vs API, and what they cost (2026)",
  description:
    "What the Model Context Protocol is, what an MCP server does, how MCP differs from an API, whether MCP servers are free, and how to connect remote and local MCP servers to AI agents in Rakazo.",
  h1: "What is MCP? Connect MCP servers to your AI agents",
  intro: [
    "The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard for connecting AI applications to outside tools and data. An app publishes an MCP server, and any agent that speaks MCP can list its tools and call them. Many apps now host a remote MCP server, so giving an agent their tools takes a URL and a sign-in. The protocol itself is free; what you pay for is the app or service behind the server.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, bots use tools in your apps, and each bot also has its own computer. You can use it on Rakazo Cloud or host it yourself. Every MCP server you add becomes tools your bots can use, alongside the apps in the [integrations catalog](/integrations/).",
  ],
  scene: {
    bot: "Bug Triage",
    color: "#D9508A",
    where: "Tools from MCP servers",
    ask: "turn last night's worst sentry errors into linear issues",
    reply: "three drafted. approve the card and i'll file them.",
    results: [
      { k: "Read", v: "6 new Sentry issues" },
      { k: "Matched", v: "2 to open Linear issues" },
      { k: "Waiting", v: "3 new issues · your approval" },
    ],
  },
  sections: [
    {
      heading: "What is MCP?",
      paragraphs: [
        "MCP defines how an AI application finds the tools a server offers, calls them and gets results back. Anthropic released it in November 2024 and in December 2025 donated it to the Agentic AI Foundation, part of the Linux Foundation. The protocol is open source and its [specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) is developed in public. Claude, ChatGPT, Cursor, VS Code and many agent frameworks speak it.",
        "Before MCP, every AI app had to write its own integration for every service, and every service had to support every AI app. MCP turns that into one integration on each side: a service writes one server, and every MCP client can use it.",
      ],
      image: true,
    },
    {
      heading: "What is an MCP server?",
      paragraphs: [
        "An MCP server is a program that offers an AI application three kinds of things: **tools** it can call, such as `create_issue`; **resources** it can read, such as files or records; and **prompts**, reusable instructions for a task. The client asks the server what it has, shows the tool names and descriptions to the model, and runs a tool when the model picks one. Messages are JSON-RPC.",
        "A local server is a program on the same machine as the agent, talking over standard input and output (stdio). A remote server lives on the web and is reached over HTTP, using the Streamable HTTP transport or the older SSE one. Remote servers that need an account use [OAuth](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), so you sign in with the app in your browser and the agent never sees your password.",
        "Most MCP servers sit in front of an API the app already has. The server doesn't replace the API; it describes a useful slice of it in a way a model can use.",
      ],
    },
    {
      heading: "MCP vs API: what's the difference?",
      paragraphs: [
        "An API is how programs talk to a service. MCP is how an AI application finds and uses tools, and the tools usually call an API underneath. You don't choose one instead of the other; you choose whether your agent talks to the API through an MCP server, or calls it directly through something like an [API connector](/integration-platforms/api-connectors/).",
      ],
      table: {
        caption: "MCP compared with a REST or GraphQL API",
        columns: ["Compared", "MCP server", "REST or GraphQL API"],
        rows: [
          { topic: "Written for", cells: ["A model choosing what to do", "A developer writing code"] },
          {
            topic: "Discovery",
            cells: ["The client asks the server for its tools at run time", "You read the docs or an OpenAPI description ahead of time"],
          },
          {
            topic: "Shape",
            cells: ["A few task-sized tools with plain-language descriptions", "Many endpoints, one per resource and method"],
          },
          {
            topic: "Sign-in",
            cells: ["OAuth for remote servers, defined by the spec", "Whatever the API chose: keys, OAuth, signed requests"],
          },
          {
            topic: "Connection",
            cells: ["A session over stdio or Streamable HTTP", "Independent HTTP requests"],
          },
          {
            topic: "Works with",
            cells: ["Any MCP client, without code", "Code written for that API, or a connector that reads its description"],
          },
          {
            topic: "Rate limits and cost",
            cells: ["Those of the API behind it", "The API's own"],
          },
          {
            topic: "Best when",
            cells: ["The app publishes a server, or an agent needs a curated set of tools", "There is no MCP server, or you need an operation the server leaves out"],
          },
        ],
      },
    },
    {
      heading: "Are MCP servers free? What MCP costs",
      paragraphs: [
        "MCP itself costs nothing: the specification and official SDKs are open source, and there is no license or per-call fee for using the protocol. What you pay depends on who runs the server and what it calls.",
      ],
      table: {
        caption: "What you pay for an MCP server",
        columns: ["Kind of server", "Examples", "What it costs"],
        rows: [
          {
            topic: "An app's own remote server",
            cells: [
              "GitHub, Linear, Notion, Sentry, Stripe, Atlassian, HubSpot",
              "Nothing extra. You need an account on the app, and its plan and API limits apply.",
            ],
          },
          {
            topic: "An open source server you run",
            cells: [
              "Database, file system and browser servers",
              "Free software; you pay for the machine it runs on.",
            ],
          },
          {
            topic: "A hosted gateway for many apps",
            cells: [
              "Zapier MCP, [Composio](/integration-platforms/composio/), [Pipedream](/integration-platforms/pipedream/)",
              `Usage-based. Zapier spends ${ZAPIER.tasksPerCall} tasks per call, from ${usd(ZAPIER.pro[0].price)} a month billed yearly for ${count(ZAPIER.pro[0].tasks)} tasks; Composio is free to ${count(COMPOSIO.freeCalls)} calls; Pipedream Connect starts at ${usd(PIPEDREAM.yearlyFee)} a month.`,
            ],
          },
          {
            topic: "A paid data service",
            cells: ["Search, enrichment and market data servers", "The service's own per-request price."],
          },
          {
            topic: "The model's context",
            cells: [
              "Every server",
              "Each tool's name and description is sent to the model, so many tools mean more input tokens on every turn.",
            ],
          },
        ],
        note: `Gateway prices from [Zapier](${ZAPIER_PRICING}), [Composio](${COMPOSIO_PRICING}) and [Pipedream](${PIPEDREAM_PRICING}), checked ${PRICES_CHECKED}. In Rakazo, MCP servers are included in every plan, on Rakazo Cloud and self-hosted.`,
      },
      bullets: [
        "The hidden cost is usually tokens, not fees. A server with 40 tools can add thousands of input tokens to every model call. Rakazo counts tools by source, not per server: the MCP servers and OpenAPI and GraphQL connectors installed from **Integrations** share one count, so a few small servers and one large API can add up together. Up to 20 tools, a bot gets them all directly; past that, it searches for the tools it needs and loads only those.",
        "A gateway that covers thousands of apps costs money and sees your data in transit. If the app publishes its own server, connecting to it directly is cheaper and has one fewer company in the middle.",
      ],
    },
    {
      heading: "Good MCP servers to start with",
      paragraphs: [
        "The best MCP server for an app is usually the one the app's own team publishes, because they keep it in step with the API. Many well-known apps now host one with OAuth sign-in: GitHub, Linear, Notion, Sentry, Stripe, Atlassian, Asana, HubSpot, Cloudflare, Supabase and Vercel among them. **Browse MCP servers** in Rakazo searches [integrations.sh](https://integrations.sh) for an app's server so you don't have to hunt for the URL.",
        "Rakazo bots already have their own computer with a browser and a terminal, so the local servers popular in coding tools, for files, browsing or running commands, add little. Spend MCP servers on the apps your bots need to work in.",
      ],
    },
    {
      heading: "What bots can do with MCP servers in Rakazo",
      bullets: [
        "Add a remote server by URL, or find an app's server with **Browse MCP servers**, which searches [integrations.sh](https://integrations.sh). Rakazo speaks Streamable HTTP and the older SSE transport.",
        "Sign in with OAuth. Rakazo registers itself with the provider when it allows that, stores the grant encrypted and refreshes it. Servers that take a bearer token or a custom header work too, and the credential is never sent to the model.",
        "Choose which bots use a server. A bot asks in the chat before its first use; choose **Approve**, or **Authorize** if you need to sign in.",
        "See when a server breaks. **Test connection** shows whether it works and why not. A bot whose server is down is told so instead of quietly losing its tools.",
        "Follow your [approval settings](/docs/approvals/). In **Ask** mode a bot asks before a call that changes something. Tools the server marks as read-only usually run without asking.",
        "Install a plugin from GitHub that bundles remote MCP servers with skills that teach bots to use them. Anyone can build one and [submit it](/plugins/submit/).",
      ],
    },
    {
      heading: "Zapier MCP and other hosted MCP gateways",
      paragraphs: [
        "Zapier MCP, Arcade, Merge Agent Handler and similar services put many apps behind one MCP endpoint. Rakazo has no built-in support for them, but any of them is just a remote MCP server to Rakazo, as long as it speaks Streamable HTTP or SSE and signs in with OAuth, a bearer token or a single custom header. Zapier MCP uses Streamable HTTP and OAuth, so you add its URL and sign in.",
        `Two things to know. A gateway acts as whoever signed in to it, so every bot that uses it acts as that person's accounts. And it bills by its own meter: each successful Zapier MCP call spends ${ZAPIER.tasksPerCall} tasks from your Zapier plan.`,
      ],
    },
    {
      heading: "When to choose MCP servers",
      paragraphs: [
        "Choose an MCP server when the app already publishes one. The app's own team decides what the tools do, there is no platform in the middle, and there is no fee beyond the app's own plan. If you host Rakazo yourself, MCP is also how you reach an internal tool or run a server on your own machine.",
        "[Composio](/integration-platforms/composio/) and [Pipedream](/integration-platforms/pipedream/) are managed platforms with ready-made tools for many apps, which helps when an app has no good MCP server. If an app only has a REST or GraphQL API, [API connectors](/integration-platforms/api-connectors/) turn it into tools. The [comparison](/integration-platforms/) puts all four side by side.",
      ],
    },
    {
      heading: "Limits and security",
      bullets: [
        "Remote servers must be at a public HTTPS address. Localhost and private networks are refused unless the operator sets `MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker, which allows them for every user. Cloud metadata addresses stay blocked.",
        "Stdio servers are off unless the API and worker have `MCP_STDIO_ENABLED=true` and the command is in `MCP_STDIO_ALLOWED_COMMANDS`. They run with the server's own access, so only admins, the verified accounts in `RAKAZO_ADMIN_EMAILS`, can add one. Bots never do.",
        "`npx` packages are installed once without running install scripts. Other runners such as `uvx` are refused; install those servers on the host and allowlist the binary.",
        "Plugins can only include remote servers, and Rakazo never runs code from a plugin's repository.",
        "Very large tool results are cut to fit the bot's context, unless you turn on **Keep tool results whole** for that server.",
        "A tool can return text anyone wrote, such as an email. Keep **Ask** or **Auto** approvals on for bots whose servers can make changes.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone with an account can add a remote server, on Rakazo Cloud or a self-hosted server. Stdio servers are for admins of a [self-hosted Rakazo](/self-hosted-ai-agent/). See [Connect apps](/docs/integrations/) and the [tools and integrations guide](/docs/self-host-integrations/).",
      ],
      steps: [
        "Open **Integrations** from **Connect apps** at the bottom of the sidebar and choose **+**.",
        "Choose **Browse MCP servers**, search for the app and choose **Connect**. To enter a URL yourself, use **Manage MCP servers** → **Add server**.",
        "Choose **Connect OAuth** and sign in if the server asks. If the provider only accepts a client you create in its console, open **Advanced**, add the **Redirect URI** shown there to that client, then enter its client ID, and its secret for a confidential client.",
        "Ask a bot to use the server and approve its first use, or choose **Use in this bot**.",
        "For a stdio server, an admin sets `MCP_STDIO_ENABLED` and `MCP_STDIO_ALLOWED_COMMANDS` on the API and worker, then adds it under **Add server** → **STDIO**.",
      ],
    },
  ],
  image: {
    ...homepage(
      "mcp",
      "Model Context Protocol",
      "The Model Context Protocol docs page, headed What is the Model Context Protocol (MCP)?",
    ),
    caption: "The Model Context Protocol documentation.",
  },
  faq: [
    {
      question: "What does MCP stand for?",
      answer:
        "Model Context Protocol: an open standard for connecting AI applications to tools and data. An MCP server offers tools, and an MCP client, such as an AI assistant or agent, calls them.",
    },
    {
      question: "Is MCP like an API for AI?",
      answer:
        "Roughly. MCP is a standard way for an AI application to discover and call tools, and those tools usually call an ordinary API underneath. An API is written for developers; an MCP server describes a slice of it for a model.",
    },
    {
      question: "Is an MCP server free or paid?",
      answer:
        `The protocol is free and open source. Most apps' own MCP servers cost nothing beyond the app's plan. Hosted gateways that cover many apps charge by use: Zapier MCP spends ${ZAPIER.tasksPerCall} tasks per call, and Composio and Pipedream bill per call or credit. Every tool also uses model tokens.`,
    },
    {
      question: "Where does an MCP server run?",
      answer:
        "A local server runs as a program on the same machine as the AI application and talks over stdio. A remote server runs on the app's or a provider's servers and is reached over HTTPS.",
    },
    {
      question: "Does ChatGPT use MCP?",
      answer:
        "Yes. ChatGPT can connect to remote MCP servers, and so can Claude, Cursor, VS Code and Rakazo. A server written once works with all of them.",
    },
    {
      question: "Can I use Zapier MCP with Rakazo?",
      answer:
        `Yes, as a remote MCP server: add its URL under **Integrations** and sign in with OAuth. It acts as the Zapier account that signed in, and each call spends ${ZAPIER.tasksPerCall} Zapier tasks. Rakazo has no Zapier-specific integration.`,
    },
    {
      question: "How do I connect a remote MCP server that uses OAuth?",
      answer:
        "Add its URL in **Integrations**, choose **Connect OAuth** and sign in with the app. Rakazo stores the grant encrypted and refreshes it. If the provider only accepts a client you create, register the **Redirect URI** shown under **Advanced** with it, then enter its client ID there, plus the secret for a confidential client.",
    },
    {
      question: "Can I run local stdio MCP servers?",
      answer:
        "Yes, on a self-hosted Rakazo with `MCP_STDIO_ENABLED=true` and the command listed in `MCP_STDIO_ALLOWED_COMMANDS`. Only admins can add one, because it runs with the server's own access.",
    },
    {
      question: "Can bots reach an MCP server on localhost or my network?",
      answer:
        "Only on a self-hosted Rakazo with `MCP_ALLOW_PRIVATE_ENDPOINT=true`. It applies to every user, so leave it off on public installs.",
    },
    {
      question: "Do too many MCP tools slow an agent down?",
      answer:
        "Every tool description takes room in the model's context. Rakazo counts tools by source, not per server: the MCP servers and OpenAPI and GraphQL connectors installed from **Integrations** share one count, so a few small servers and one large API can add up together. Up to 20 tools, a bot gets them all directly; past that, it searches for the tools it needs and loads only those.",
    },
  ],
  sources: [
    {
      label: "Model Context Protocol",
      href: "https://modelcontextprotocol.io/docs/getting-started/intro",
    },
    {
      label: "MCP specification, transports",
      href: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports",
    },
    {
      label: "MCP specification, authorization",
      href: "https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization",
    },
    {
      label: "Anthropic, donating MCP to the Agentic AI Foundation",
      href: "https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation",
    },
    { label: "Zapier MCP", href: "https://zapier.com/mcp" },
    { label: "Zapier MCP docs", href: "https://docs.zapier.com/mcp/home" },
    { label: "Zapier pricing", href: ZAPIER_PRICING },
    { label: "integrations.sh", href: "https://integrations.sh" },
    INTEGRATIONS_DOC,
    { label: "Rakazo, connect apps", href: `${GITHUB_URL}/blob/main/docs/integrations.md` },
    { label: "Rakazo, build a plugin", href: `${GITHUB_URL}/blob/main/docs/build-a-plugin.md` },
  ],
};
