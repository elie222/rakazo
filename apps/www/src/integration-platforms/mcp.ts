import { GITHUB_URL } from "../site";
import { INTEGRATIONS_DOC, homepage } from "./shared";
import type { IntegrationPlatform } from "./types";

export const mcp: IntegrationPlatform = {
  slug: "mcp",
  name: "MCP servers",
  gives: "Tools from any MCP server, remote or local",
  logins: "Your OAuth grant or token, encrypted in Rakazo",
  bestFor: "Apps that publish their own MCP server",
  title: "MCP servers for AI agents: connect remote and local MCP tools",
  description:
    "What MCP is, and how to connect MCP servers to AI agents in Rakazo: remote servers with OAuth sign-in, approvals and health checks, or local stdio servers when you self-host.",
  h1: "Connect MCP servers to your AI agents",
  intro: [
    "The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard for connecting AI applications to outside tools and data. An app publishes an MCP server, and any agent that speaks MCP can list its tools and call them. Many apps now host a remote MCP server, so giving an agent their tools takes a URL and a sign-in.",
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
        "MCP defines how an AI application finds the tools a server offers, calls them and gets results back. Anthropic released it in November 2024 and in December 2025 donated it to the Agentic AI Foundation, part of the Linux Foundation. The protocol is open source and its [specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) is developed in public.",
        "A local server is a program on the same machine as the agent, talking over standard input and output (stdio). A remote server lives on the web and is reached over HTTP. Remote servers that need an account use [OAuth](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), so you sign in with the app in your browser and the agent never sees your password.",
      ],
      image: true,
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
      heading: "When to choose MCP servers",
      paragraphs: [
        "Choose an MCP server when the app already publishes one. The app's own team decides what the tools do, and there is no platform in the middle. If you host Rakazo yourself, MCP is also how you reach an internal tool or run a server on your own machine.",
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
        "Choose **Connect OAuth** and sign in if the server asks. If the provider only accepts its own client, add the client ID under **Advanced**.",
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
      question: "How do I connect a remote MCP server that uses OAuth?",
      answer:
        "Add its URL in **Integrations**, choose **Connect OAuth** and sign in with the app. Rakazo stores the grant encrypted and refreshes it. If the provider only accepts a client you create, enter its client ID under **Advanced**.",
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
        "Every tool description takes room in the model's context. Rakazo gives a bot up to 20 MCP tools directly; past that, the bot searches for the tools it needs and loads only those.",
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
    INTEGRATIONS_DOC,
    { label: "Rakazo, connect apps", href: `${GITHUB_URL}/blob/main/docs/integrations.md` },
    { label: "Rakazo, build a plugin", href: `${GITHUB_URL}/blob/main/docs/build-a-plugin.md` },
  ],
};
