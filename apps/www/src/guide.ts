import {
  DOCS_URL,
  GITHUB_URL,
  OPENCLAW_ALTERNATIVE_PATH,
  SELF_HOST_GUIDE_PATH,
  SELF_HOST_RESTRICTED_URL,
  SELF_HOST_SECRETS_URL,
  SETUP_PROMPT_URL,
  SITE_URL,
} from "./site";

export const OPENCLAW_DOCS_URL = "https://docs.openclaw.ai/";
export const OPENCLAW_GETTING_STARTED_URL = "https://docs.openclaw.ai/start/getting-started";
export const OPENCLAW_FEATURES_URL = "https://docs.openclaw.ai/concepts/features";
export const OPENCLAW_SANDBOX_URL = "https://docs.openclaw.ai/gateway/sandboxing";
export const OPENCLAW_GITHUB_URL = "https://github.com/openclaw/openclaw";

export const PUBLISHED_IMAGES_INSTALL = `mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh`;

export const PUBLISHED_IMAGES_SERVER = `bash install-images.sh --prepare-only
# Edit .env, then:
bash install-images.sh`;

export const SOURCE_CHECKOUT = `git clone https://github.com/elie222/rakazo.git
cd rakazo
cp .env.example .env`;

export const SOURCE_DEV = `docker compose --env-file .env \\
  -f infra/compose/docker-compose.yml \\
  -f infra/compose/docker-compose.postgres-host.yml \\
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev`;

export const CADDY_SNIPPET = `app.example.com {
	reverse_proxy 127.0.0.1:5173
}`;

export const RUN_ON_YOUR_MAC =
  "Run on your Mac with the desktop app. This computer installs Rakazo on that Mac. A Mac Mini can stay on as the always-on box.";

export type FaqItem = {
  question: string;
  answer: string;
};

export type ComparisonRow = {
  aspect: string;
  rakazo: string;
  openclaw: string;
};

export const SELF_HOST_TITLE = "Self-Hosted AI Agent (Open Source) – Rakazo";
export const SELF_HOST_DESCRIPTION =
  "Run Rakazo yourself: an open source AI agent with your data, your model, and your costs. Requirements and the setup steps for Docker or a source checkout.";

export const OPENCLAW_H1 = "Open source OpenClaw alternative";
export const OPENCLAW_TITLE = "Open Source OpenClaw Alternative – Rakazo";
export const OPENCLAW_UPDATED = "October 7, 2026";
export const OPENCLAW_DESCRIPTION =
  "Rakazo and OpenClaw are both open source, self-hosted AI agents. Rakazo keeps setup and daily use in chat. OpenClaw's docs add a gateway, a config file, and a background service you can install.";

export const SELF_HOST_FAQS: readonly FaqItem[] = [
  {
    question: "What do I need to self-host Rakazo?",
    answer:
      "Published images need Docker Engine 26 or newer, the Compose plugin, curl, and OpenSSL. You do not need Node.js for that path. A source checkout needs Node.js 22.22.2 or newer on the 22.x line, Node.js 24.x, or Node.js 26 or newer, plus pnpm 9 and Docker. Node.js 23.x and 25.x are not supported.",
  },
  {
    question: "Where does my data live?",
    answer:
      "Postgres, bot files, browser profiles, and the audit log stay on the deployment you run. Content you send to a model provider is processed by that provider under its terms. You choose the provider and the keys.",
  },
  {
    question: "How do model choice and cost work?",
    answer:
      "You connect your own model keys, or a local or OpenAI-compatible model server, and you can pick a different model per bot. The open source software has no seat fee. You pay the model and computer providers you use. Local Docker computers are the default and do not need a hosted sandbox account.",
  },
  {
    question: "Is hosted Rakazo available?",
    answer:
      "Self-hosting is available now. Hosted Rakazo Cloud is not generally available. Get started includes a waitlist for Cloud.",
  },
  {
    question: "How does this compare with OpenClaw?",
    answer:
      "Both are open source and run on hardware you control. After a Docker or desktop install, Rakazo is a chat for persistent teammates. OpenClaw's getting-started guide adds a wizard, a Gateway you run in the terminal or install as a background service, and a separate step to connect a chat app.",
  },
];

export const OPENCLAW_SETUP_PARAGRAPHS = [
  "Rakazo's self-host path is the published Docker installer, or the desktop app starting that stack on this computer. You create an account and connect a model. From there it is just chat, on the web, desktop, and mobile apps. A new bot interviews you about the work, and you manage the bot from that chat. Routines are readable Markdown.",
  "OpenClaw's getting-started guide installs the CLI, then runs a wizard. Quick start is the short path when a Claude Code or Codex login, or an API key, is already on the machine. Custom setup walks through the full flow, and `openclaw onboard --classic` is the step-by-step wizard. Quick start leaves the Gateway in that terminal until you stop it, so you can chat before installing a service. `openclaw gateway install` is the later step that keeps it in the background: a LaunchAgent on macOS, a systemd user unit on Linux, or a Scheduled Task on Windows. You check `openclaw gateway status` (the guide says port 18789) and open `openclaw dashboard`. Messaging from a phone, such as Telegram, is a separate Channels step.",
] as const;

export const OPENCLAW_DAY_TO_DAY_PARAGRAPHS = [
  "Day to day, you manage Rakazo from the same chat. Schedules, memory, and approval boundaries stay with that bot, on the web, desktop, and mobile apps. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark. They are not required to use the product.",
  "OpenClaw's docs send later changes through `openclaw configure` and a JSON config file, `~/.openclaw/openclaw.json` unless you override the path. `openclaw doctor` and `openclaw triage` diagnose the install. The Gateway is the process you keep running, in a terminal or as the installed background service, and chat apps are the main way you message the assistant, alongside the Control UI.",
] as const;

export const OPENCLAW_FAQS: readonly FaqItem[] = [
  {
    question: "Is Rakazo simpler to set up than OpenClaw?",
    answer:
      "The documented paths are different. Rakazo's self-host guide is a Docker installer, or the desktop app starting that stack, then an account and a model. After that Rakazo is just chat, and you manage the bot from that chat. OpenClaw's getting-started guide is an installer and a wizard (Quick start or Custom setup). You can chat while the Gateway runs in that terminal. `openclaw gateway install` keeps it running in the background, then `openclaw gateway status` and `openclaw dashboard`. Connecting a chat app is another step. OpenClaw can be short when a model login is already detected. The ongoing surface is still the Gateway and the config file.",
  },
  {
    question: "Can I chat with OpenClaw before installing a background service?",
    answer:
      "Yes. Quick start leaves the Gateway in that terminal until you stop it, so you can send a message before `openclaw gateway install`. That command is the later step that keeps the Gateway in the background: a LaunchAgent on macOS, a systemd user unit on Linux, or a Scheduled Task on Windows. Rakazo does not add a gateway service. After Docker or the desktop app, the product is the chat.",
  },
  {
    question: "Do I manage OpenClaw from the chat?",
    answer:
      "You message the assistant from chat apps or the Control UI. The docs send later changes through `openclaw configure` and `~/.openclaw/openclaw.json`. `openclaw doctor` and `openclaw gateway status` are separate commands. Rakazo keeps schedules, memory, and approval boundaries in the same chat, the way Grok Bot does.",
  },
  {
    question: "Is Rakazo just chat, like Grok Bot?",
    answer:
      "After the install, yes. You set up the bot and manage it from that chat on the web, desktop, and mobile apps. OpenClaw is also a conversation, and its docs add a Gateway you keep running and a config file for later changes. The two are not interchangeable. Rakazo does not import an OpenClaw setup.",
  },
  {
    question: "Is Rakazo a drop-in replacement for OpenClaw?",
    answer:
      "No. Rakazo does not import OpenClaw configuration, skills, or channel sessions. It is a separate open source agent you self-host.",
  },
  {
    question: "How do the licenses differ?",
    answer:
      "Rakazo is released under the Apache-2.0 license. OpenClaw is released under the MIT license and is stewarded by the OpenClaw Foundation, an independent 501(c)(3).",
  },
  {
    question: "Do both keep data on my machine?",
    answer:
      "Yes for the software you run. OpenClaw's documentation says state, memory, and credentials live on your hardware, and that there is no hosted service in the middle. A Rakazo deployment stores its database and bot data on your host. In both cases, prompts go to the model provider you configure, and to any chat service you connect.",
  },
  {
    question: "Can I choose my own model with either one?",
    answer:
      "Yes. Rakazo supports OpenAI, Anthropic, Google, OpenRouter, Vercel AI Gateway, an OpenAI-compatible endpoint, and a local model server, with a choice per bot. OpenClaw documents Anthropic, OpenAI, Google, and other providers, including self-hosted OpenAI-compatible and Anthropic-compatible endpoints, plus failover.",
  },
  {
    question: "Does either project charge for the software?",
    answer:
      "Rakazo is free to self-host. Hosted Rakazo Cloud is not generally available. OpenClaw's documentation says the project has no paid tier and no hosted service. You still pay for models, machines, and any optional computer providers you use.",
  },
];

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    aspect: "Setup",
    rakazo:
      "Docker installer or the desktop app's local stack, then an account and a model. After that Rakazo is just chat: a new bot interviews you, and you manage it from the chat.",
    openclaw:
      "CLI install, then Quick start or Custom setup. The Gateway can stay in that terminal for a first chat. `openclaw gateway install` is the background service (LaunchAgent, systemd user unit, or Windows Scheduled Task). Then `openclaw gateway status` and `openclaw dashboard`. A phone channel is a separate step.",
  },
  {
    aspect: "Day-to-day management",
    rakazo:
      "You manage the bot from the same chat on the web, desktop, and mobile apps. Routines are readable Markdown and can run on a schedule. A bot can pause for approval at a boundary you set.",
    openclaw:
      "Later changes go through `openclaw configure` and `~/.openclaw/openclaw.json`. `openclaw doctor` and `openclaw triage` diagnose the install. The Gateway stays running in a terminal or as the installed background service.",
  },
  {
    aspect: "What it is",
    rakazo:
      "An open source platform for persistent AI teammates. Bots keep conversations, memory, routines, and history, and can use a browser, shell, and desktop.",
    openclaw:
      "A self-hosted gateway that connects chat apps to an AI assistant on your machine. The project describes one Gateway for the channels you already use.",
  },
  {
    aspect: "License",
    rakazo: "Apache-2.0. Maintained in the open by Inbox Zero Inc.",
    openclaw: "MIT. Stewarded by the OpenClaw Foundation, an independent 501(c)(3).",
  },
  {
    aspect: "Where it runs",
    rakazo:
      "You self-host with published Docker images or from source. Web, desktop, and mobile apps are clients of that API. Hosted Rakazo Cloud is not generally available.",
    openclaw:
      "You run the Gateway on your own computer or a server. The docs say there is no hosted service in the middle. Interfaces include a browser Control UI, companion apps, and iOS and Android nodes.",
  },
  {
    aspect: "How you talk to it",
    rakazo:
      "The Rakazo web app, Electron desktop app, and Expo mobile app. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark.",
    openclaw:
      "Chat apps are the primary surface. Documented channels include Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and others via plugins, plus WebChat.",
  },
  {
    aspect: "Models",
    rakazo:
      "Bring your own keys for OpenAI, Anthropic, Google, OpenRouter, or Vercel AI Gateway. OpenAI-compatible endpoints and a local model server (Ollama, LM Studio, llama.cpp, or MLX) are supported. Each bot can use a different model.",
    openclaw:
      "Many providers, including Anthropic, OpenAI, and Google, plus OAuth for some subscriptions such as OpenAI Codex. Self-hosted endpoints include vLLM, SGLang, Ollama, llama.cpp, LM Studio, and other OpenAI-compatible or Anthropic-compatible servers, with failover.",
  },
  {
    aspect: "Computers and tools",
    rakazo:
      "Browser, terminal, files, and a graphical desktop. The default computer is local Docker. Optional remote computers are E2B, Daytona, CreateOS, and Box. An explicit desktop provider can run on the host; it is not the default.",
    openclaw:
      "Tools include browser automation and exec. Sandboxing is off by default. When enabled, documented backends include Docker, Podman, SSH, OpenShell, and Crabbox. The Gateway process stays on the host.",
  },
  {
    aspect: "Routines and memory",
    rakazo:
      "Routines are saved as readable Markdown. Memory, schedules, an audit log, and approval boundaries are part of the product.",
    openclaw:
      "Sessions, memory, skills, cron, hooks, and plugins. Direct chats can share a main session. Group chats are isolated by default.",
  },
  {
    aspect: "Integrations",
    rakazo:
      "Optional Composio or Pipedream catalogs, plus MCP servers, Treg, and OpenAPI tools you add.",
    openclaw: "Channel plugins, skills, a plugin SDK, and web search through several providers.",
  },
  {
    aspect: "More than one agent",
    rakazo: "Bots can delegate to peer bots or short-lived subagents.",
    openclaw: "Multi-agent routing with isolated sessions per agent, workspace, or sender.",
  },
  {
    aspect: "Software cost",
    rakazo: "No seat fee for the open source software. You pay the models and infrastructure you use.",
    openclaw: "The docs say there is no paid tier. You pay the models and the machine you run.",
  },
];

export function faqPageStructuredData(items: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

function faqMarkdown(items: readonly FaqItem[]): string {
  return items.map((item) => `### ${item.question}\n\n${item.answer}`).join("\n\n");
}

function comparisonMarkdown(): string {
  const header = "| | Rakazo | OpenClaw |\n| --- | --- | --- |";
  const rows = COMPARISON_ROWS.map(
    (row) => `| ${row.aspect} | ${row.rakazo} | ${row.openclaw} |`,
  );
  return [header, ...rows].join("\n");
}

export const SELF_HOST_MARKDOWN = `# Self-hosted AI agent

> Open source AI agent you run on a machine you control. Your keys, your model, your data.

Rakazo is an open source AI agent for persistent teammates. Each bot can use a browser and a shell, keep routines as Markdown, and pause for approval when work crosses a boundary you set. Self-hosting means that stack runs on infrastructure you operate.

The software is [Apache-2.0](${GITHUB_URL}/blob/main/LICENSE). Hosted Rakazo Cloud is not generally available. This page is the essential setup. The [full self-hosting guide](${DOCS_URL}) on GitHub covers backups, upgrades, secrets, restricted networks, and production Compose.

## What self-hosting gives you

### Data ownership

Postgres, bot files, browser profiles, and the audit log stay on the deployment you run. Content you send to a model provider is processed by that provider under its terms. You choose the provider and the keys.

### Model choice

Connect OpenAI, Anthropic, Google, OpenRouter, or Vercel AI Gateway. You can also use an OpenAI-compatible endpoint or a local model server such as Ollama, LM Studio, llama.cpp, or MLX. Each bot can use a different model.

### Cost control

There is no seat fee for the open source software. You pay the model provider you connect and any remote computer provider you choose. Local Docker computers are the default, so a single machine does not need an E2B, Daytona, CreateOS, or Box account.

## Requirements

Published images need Docker Engine 26 or newer (API 1.45 or newer, for bot home volume subpaths), the Compose plugin, curl, and OpenSSL. No Node.js install.

A source checkout needs Node.js 22.22.2 or newer on the 22.x line, Node.js 24.x, or Node.js 26 or newer, plus pnpm 9 and Docker. Node.js 23.x and 25.x are not supported.

## Install with published images

\`\`\`bash
${PUBLISHED_IMAGES_INSTALL}
\`\`\`

The installer downloads the Compose file and \`.env.images.example\`, creates \`.env\` with random secrets, and starts Rakazo. It keeps an existing \`.env\` when you run it again. The default image tag is \`edge\` (builds from the main branch, \`linux/amd64\` and \`linux/arm64\`).

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and create an account. The first registered user becomes the deployment owner. Connect a model in the app, or set \`OPENROUTER_API_KEY\` before startup. Local Docker computers are on by default.

For an agent-assisted install, use the [setup prompt](${SETUP_PROMPT_URL}).

## Run it on a server

Use the same installer on a VPS when bots should stay running. Images Compose binds the web app to loopback \`127.0.0.1:5173\`. Terminate TLS on the host and proxy there. Do not publish port 3100. The web server proxies \`/api\`.

\`\`\`bash
${PUBLISHED_IMAGES_SERVER}
\`\`\`

Before the second command, set \`RAKAZO_HOST\` to the hostname and set \`BETTER_AUTH_URL\`, \`WEB_ORIGIN\`, and \`API_URL\` to that same \`https://\` origin. For a remote computer instead of local Docker, set \`SANDBOX_PROVIDER\` to \`e2b\`, \`daytona\`, \`createos\`, or \`box\` and add that provider's API key.

\`\`\`Caddyfile
${CADDY_SNIPPET}
\`\`\`

Replace \`app.example.com\` with your host. Desktop clients should use **Existing instance** with the \`https://\` address. The [public single-VM section](${DOCS_URL}#public-single-vm-deployment) covers production Compose, host hardening, signup allowlists, and SMTP.

If downloads are blocked, use the [restricted-network guide](${SELF_HOST_RESTRICTED_URL}). Secret names and recovery are in the [secrets checklist](${SELF_HOST_SECRETS_URL}).

## Install from source

\`\`\`bash
${SOURCE_CHECKOUT}
\`\`\`

Set \`POSTGRES_PASSWORD\` to a URI-safe random value (for example \`openssl rand -hex 16\`) and put the same value in \`DATABASE_URL\`. Set \`BETTER_AUTH_SECRET\`, \`ENCRYPTION_KEY\`, and \`SCREEN_PROXY_SECRET\` to independent long random values. Docker sandboxes also need a dedicated \`SANDBOX_SUPERVISOR_TOKEN\`. Keep these in \`.env\`, not in git.

For host-side development with Docker Desktop, set \`SANDBOX_CONTROL_VIA_LOOPBACK=true\` in \`.env\`. The supervisor then publishes its control service on a loopback port, because Docker Desktop container addresses are not reachable from the host. Leave this unset when the supervisor runs inside Compose.

\`\`\`bash
${SOURCE_DEV}
\`\`\`

The Postgres overlay publishes loopback \`127.0.0.1:5433\` for host-side tools. Open [http://127.0.0.1:5173](http://127.0.0.1:5173). \`docker compose down -v\` deletes Postgres data.

## Desktop and mobile

With a server already running, the Electron app's **Existing instance** option takes its \`https://\` address (HTTP is accepted only for loopback and private LAN addresses). **This computer** installs the published images with Docker Compose on that machine.

${RUN_ON_YOUR_MAC}

In the mobile app, tap **Use a custom server** on the sign-in screen and enter the same HTTPS origin as \`WEB_ORIGIN\`.

## Full reference

- [Self-hosting guide](${DOCS_URL})
- [Secrets checklist](${SELF_HOST_SECRETS_URL})
- [Restricted networks](${SELF_HOST_RESTRICTED_URL})
- [Setup prompt](${SETUP_PROMPT_URL})
- [Source](${GITHUB_URL})

## FAQ

${faqMarkdown(SELF_HOST_FAQS)}

## Related

- [Home](${SITE_URL}/)
- [OpenClaw comparison](${SITE_URL}${OPENCLAW_ALTERNATIVE_PATH})
`;

export const OPENCLAW_RELATED = [
  { href: "/grok-bot-alternative/", label: "Grok Bot alternative" },
  { href: "/muse-alternative/", label: "Meta Muse" },
  { href: "/dots-alternative/", label: "OpenAI Dots" },
  { href: "/instinct-alternative/", label: "Instinct AI" },
  { href: "/hark-alternative/", label: "Hark Pro" },
  { href: "/hermes-alternative/", label: "Hermes Agent" },
  { href: "/alternatives/", label: "All comparisons" },
] as const;

export const OPENCLAW_MARKDOWN = `# Open source OpenClaw alternative

Updated ${OPENCLAW_UPDATED}.

> A fair comparison of Rakazo and OpenClaw, two open source ways to run an AI agent you control.

The main difference is simplicity. Like Grok Bot, Rakazo is just chat: you set up the bot and manage it from that chat. OpenClaw is also open source and self-hosted. Its [getting-started guide](${OPENCLAW_GETTING_STARTED_URL}) is a longer path: a CLI installer, an onboarding wizard, a Gateway you run in the terminal or install as a background service, and a config file.

They are not the same product, and Rakazo does not import an OpenClaw setup. This comparison follows [OpenClaw's documentation](${OPENCLAW_DOCS_URL}) and this repository. Details change. Those docs are the full source for OpenClaw.

## Setup

${OPENCLAW_SETUP_PARAGRAPHS.join("\n\n")}

## Day-to-day management

${OPENCLAW_DAY_TO_DAY_PARAGRAPHS.join("\n\n")}

## Comparison

${comparisonMarkdown()}

## Key differences

Rakazo is a web, desktop, and mobile app for persistent teammates: a bot has a job, a computer, and routines saved as Markdown. OpenClaw is a Gateway you message from chat apps, with a browser Control UI and mobile nodes.

Rakazo runs bot work on a computer. Local Docker is the default. OpenClaw can sandbox tool execution, and its docs say sandboxing is off by default. The Gateway process stays on the host.

Both let you bring a model provider, including a server you run. Neither charges a seat fee for the software. OpenClaw's docs say it has no paid tier and no hosted service. Rakazo is free to self-host. Hosted Rakazo Cloud is not generally available.

Rakazo is Apache-2.0, maintained by Inbox Zero Inc. OpenClaw is MIT, stewarded by the OpenClaw Foundation.

## Which shape fits

Choose Rakazo for repeated browser and shell work, scheduled operational routines, an audit log, and approval boundaries, shared across the web, desktop, and mobile clients.

Choose OpenClaw when the assistant should live in chat apps you already use, with channel plugins, skills, and a gateway on your machine.

## Sources

- [OpenClaw docs](${OPENCLAW_DOCS_URL})
- [OpenClaw getting started](${OPENCLAW_GETTING_STARTED_URL})
- [OpenClaw features](${OPENCLAW_FEATURES_URL})
- [OpenClaw sandboxing](${OPENCLAW_SANDBOX_URL})
- [OpenClaw source](${OPENCLAW_GITHUB_URL})
- [Rakazo self-host guide](${SITE_URL}${SELF_HOST_GUIDE_PATH})
- [Rakazo source](${GITHUB_URL})

## FAQ

${faqMarkdown(OPENCLAW_FAQS)}

## Related

- [Home](${SITE_URL}/)
- [Self-hosted AI agent guide](${SITE_URL}${SELF_HOST_GUIDE_PATH})
${OPENCLAW_RELATED.map((item) => `- [${item.label}](${SITE_URL}${item.href})`).join("\n")}
`;
