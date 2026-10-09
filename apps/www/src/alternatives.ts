import { OPENCLAW_H1 } from "./guide";
import { GROK_ALTERNATIVE_H1, GROK_ALTERNATIVE_PATH } from "./grok-alternative";
import { DOCS_URL, GITHUB_URL, OPENCLAW_ALTERNATIVE_PATH } from "./site";

/** Public descriptions were read on this date. */
export const COMPARED_ON = "October 7, 2026";

export const GET_STARTED = {
  heading: "Get started",
  copy: "Self-hosting is available now. Hosted Rakazo Cloud is not generally available.",
  docsLabel: "Self-hosting guide",
  githubLabel: "View on GitHub",
} as const;

export const OPEN_SOURCE_REASONS = [
  "The source is Apache-2.0 and public on GitHub.",
  "You can run the published Docker images, or a source checkout, on a machine you control. The desktop app can start that stack locally or connect to a server you already run.",
  "You bring the model credentials. Connector credentials are encrypted on the server and are not returned by the API.",
  "Routines are readable Markdown. A bot can pause for approval at a boundary you set, and actions are recorded in an audit log.",
  "The web app, the Electron desktop app, and the Expo mobile app are clients of the same API.",
] as const;

export type ComparisonRow = {
  topic: string;
  rakazo: string;
  other: string;
};

export type FaqItem = {
  question: string;
  answer: string;
};

export type SourceLink = {
  label: string;
  href: string;
};

export type AlternativeSection = {
  heading: string;
  paragraphs: readonly string[];
};

export type Alternative = {
  /** Path segment. The page is served at `/${slug}/`. */
  slug: string;
  /** Short product name used on the hub. */
  name: string;
  /** One sentence under the hub link. */
  summary: string;
  title: string;
  description: string;
  h1: string;
  /** Column heading for the other product. */
  otherName: string;
  intro: readonly string[];
  /** Optional sections rendered before the comparison table. */
  sections?: readonly AlternativeSection[];
  rows: readonly ComparisonRow[];
  faq: readonly FaqItem[];
  sources: readonly SourceLink[];
};

export const ALTERNATIVES_HUB = {
  title:
    "Best Personal AI Agents in 2026: Grok Bot, Muse, Dots, Instinct, Hark Pro & Open Source Alternatives",
  description:
    "A dated comparison of Grok Bot, Meta Muse, OpenAI Dots, Instinct, Hark Pro, OpenClaw, Hermes Agent, and Rakazo. Licenses, self-hosting, model choice, price, setup, and whether you manage the agent from chat.",
  h1: "Best Personal AI Agents in 2026: Grok Bot, Muse, Dots, Instinct, Hark Pro & Open Source Alternatives",
  intro:
    "These are different products that all take on work beyond a single reply. This page compares their public descriptions as of October 7, 2026. It is not a score, a benchmark, or a claim that one of them is best at every task.",
} as const;

const MUSE_SOURCES = [
  {
    label: "Meta, Introducing Muse (September 8, 2026)",
    href: "https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/",
  },
  {
    label: "Meta, Connect 2026 recap (September 23, 2026)",
    href: "https://www.meta.com/blog/meta-connect-2026-everything-we-announced/",
  },
  {
    label: "Meta, Muse for Small Business (September 29, 2026)",
    href: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
  },
] as const satisfies readonly SourceLink[];

const DOTS_SOURCES = [
  {
    label: "OpenAI, Introducing dots (September 29, 2026)",
    href: "https://openai.com/index/introducing-dots/",
  },
  {
    label: "OpenAI Help Center, Dots privacy, security, and safety FAQs",
    href: "https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs",
  },
] as const satisfies readonly SourceLink[];

const INSTINCT_SOURCES = [
  { label: "Instinct homepage", href: "https://instinct.com/" },
  {
    label: "Instinct privacy policy (revised August 26, 2026)",
    href: "https://instinct.com/privacy-policy",
  },
  {
    label: "Instinct terms of service (revised August 26, 2026)",
    href: "https://instinct.com/terms",
  },
] as const satisfies readonly SourceLink[];

const HERMES_SOURCES = [
  { label: "Hermes Agent", href: "https://hermes-agent.nousresearch.com/" },
  {
    label: "Hermes Agent quickstart",
    href: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
  },
  {
    label: "Hermes Agent configuration",
    href: "https://hermes-agent.nousresearch.com/docs/user-guide/configuration",
  },
  {
    label: "Hermes Agent security",
    href: "https://hermes-agent.nousresearch.com/docs/user-guide/security",
  },
  {
    label: "Hermes Desktop",
    href: "https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
  },
  { label: "Hermes Agent source", href: "https://github.com/NousResearch/hermes-agent" },
] as const satisfies readonly SourceLink[];

const HARK_SOURCES = [
  { label: "Hark homepage", href: "https://hark.com/" },
  {
    label: "Introducing Hark Pro (October 6, 2026)",
    href: "https://hark.com/articles/introducing-hark-pro",
  },
  {
    label: "Introducing Hark Handoff (August 5, 2026)",
    href: "https://hark.com/articles/introducing-hark-handoff",
  },
  {
    label: "Hark privacy policy (last updated October 1, 2026)",
    href: "https://hark.com/privacy-policy",
  },
  {
    label: "Hark terms of service (posted June 30, 2026)",
    href: "https://hark.com/terms",
  },
  { label: "Hark security", href: "https://hark.com/security" },
] as const satisfies readonly SourceLink[];

/**
 * Comparison pages. Add an entry here to publish `/${slug}/` and a hub card.
 */
export const ALTERNATIVES: readonly Alternative[] = [
  {
    slug: "muse-alternative",
    name: "Muse",
    summary: "Meta's personal AI agent, and what is different when you host Rakazo yourself.",
    title: "Open Source Meta Muse Alternative – Rakazo",
    description:
      "Rakazo is an open source, self-hostable platform for persistent AI teammates. Compare it with Meta's Muse personal agent.",
    h1: "Open source Meta Muse alternative",
    otherName: "Muse",
    intro: [
      "Muse is Meta's personal AI agent, introduced on September 8, 2026. It runs on a virtual machine Meta operates, and you talk to it in the Muse app or WhatsApp. Meta says it can keep working after you close the app.",
      "Rakazo is open source software for persistent AI teammates. You choose the model and the computer, and you can run the stack yourself. This is a comparison of public descriptions, not a measured benchmark.",
    ],
    rows: [
      {
        topic: "Product",
        rakazo: "Open source platform for persistent AI teammates. Rakazo is in beta.",
        other:
          "Meta's personal AI agent. Meta says it takes on tasks and longer-term goals, rather than only answering questions.",
      },
      {
        topic: "Who runs it",
        rakazo:
          "You do. Self-host with Docker, or point the desktop and mobile apps at a server you operate. Hosted Rakazo Cloud is not generally available.",
        other:
          "Meta. Muse runs on Muse Secure VM, a dedicated cloud virtual machine for the agent and for data from services you connect. Meta's September 29, 2026 post describes Muse as available in the US and Canada.",
      },
      {
        topic: "Source",
        rakazo: "Apache-2.0 source on GitHub.",
        other: "Hosted service from Meta.",
      },
      {
        topic: "Model",
        rakazo:
          "Bring your own model credentials. Multiple providers are supported, including a custom model server.",
        other: "Muse Spark, which Meta's launch post describes as the model for this agent.",
      },
      {
        topic: "Computer",
        rakazo:
          "Sandboxed browser, terminal, files, and a graphical desktop, on a shared team computer or an isolated private computer. Docker is the default local computer, with optional E2B, Daytona, CreateOS, Box, or a trusted local computer.",
        other:
          "A browser on Muse Secure VM. Meta says Muse can open that browser, fill out forms, and take on tasks such as email and booking travel. The Connect recap says Muse for Mac can drive apps on that Mac with your permission.",
      },
      {
        topic: "Connected apps",
        rakazo:
          "Composio or Pipedream Connect, or a Treg, remote MCP, or OpenAPI source you install. Connector credentials are encrypted on the server and are not returned by the API.",
        other:
          "You choose which apps Muse can use and how much access each one gets. Meta publishes connectors, including work and shopping tools, and custom connectors.",
      },
      {
        topic: "Ongoing work",
        rakazo:
          "Each bot keeps its own conversations, memory, routines, and history. Routines are readable Markdown and can run on a schedule. A bot can delegate to a peer bot or a short-lived subagent.",
        other:
          "Meta says Muse keeps working after you close the app and comes back when something changes or it needs approval.",
      },
      {
        topic: "Approval",
        rakazo:
          "A bot can pause for approval when a task crosses a boundary you set. Actions are recorded in an audit log.",
        other:
          "Meta says Muse checks with you before sensitive actions such as sending an email or paying, and shows an audit trail. The small-business post says nothing publishes, sends, or spends without your approval. You can opt out of using interactions to train Meta's models. Meta says conversations and VM data are not shared with Meta's ad systems, and that stored credentials can be used without Muse seeing the passwords.",
      },
      {
        topic: "Where you use it",
        rakazo:
          "Web app, Electron desktop app, and Expo mobile app. Voice can speak replies, take dictation, and call a bot, with your own ElevenLabs, OpenAI, Cartesia, or Fish Audio key.",
        other:
          "Muse app on iOS and Android, WhatsApp, and muse.ai, per the launch. The Connect recap adds the Mac app, a voice mode you can shape, and Muse on AI glasses in the coming months.",
      },
    ],
    faq: [
      {
        question: "Is Rakazo a replacement for Muse?",
        answer:
          "No. Muse is Meta's hosted personal agent, with the Muse app, WhatsApp, and a virtual machine Meta operates. Rakazo is open source software for persistent AI teammates on infrastructure you control. Both can keep working beyond a single chat. They differ on hosting, model choice, and which products are built in.",
      },
      {
        question: "Can I self-host Rakazo?",
        answer:
          "Yes. Self-hosting is available now with published Docker images or a source checkout. Hosted Rakazo Cloud is not generally available.",
      },
      {
        question: "Does Rakazo include Muse on WhatsApp, shopping checkout, or AI glasses?",
        answer:
          "No. Those are Muse surfaces Meta describes. Rakazo's clients are the web app, the Electron desktop app, and the Expo mobile app. Voice in Rakazo uses a key you bring for ElevenLabs, OpenAI, Cartesia, or Fish Audio.",
      },
      {
        question: "Where do the Muse details come from?",
        answer:
          "The Muse column summarizes Meta's September 8, 2026 launch, the September 23, 2026 Connect recap, and the September 29, 2026 small-business post. Check those posts before you rely on a specific capability.",
      },
    ],
    sources: MUSE_SOURCES,
  },
  {
    slug: "dots-alternative",
    name: "Dots",
    summary: "OpenAI's always-on agents, in a shorter comparison.",
    title: "Open Source OpenAI Dots Alternative – Rakazo",
    description:
      "Rakazo is an open source, self-hostable platform for persistent AI teammates. Compare it with OpenAI's Dots agents.",
    h1: "Open source OpenAI Dots alternative",
    otherName: "Dots",
    intro: [
      "Dots are OpenAI's always-on agents, announced on September 29, 2026. OpenAI says they use GPT-6 Astra, have their own cloud computer, and are rolling out on eligible Pro, Business Premium, and Enterprise plans.",
      "Rakazo is separate software: open source AI teammates you can host yourself, with model credentials you bring.",
    ],
    rows: [
      {
        topic: "Product",
        rakazo: "Open source platform for persistent AI teammates. Rakazo is in beta.",
        other:
          "Always-on agents from OpenAI. OpenAI says a dot learns from feedback and can work toward your goals continuously.",
      },
      {
        topic: "Who runs it",
        rakazo:
          "You do. Self-host with Docker, or point the desktop and mobile apps at a server you operate. Hosted Rakazo Cloud is not generally available.",
        other: "OpenAI. The announcement says each dot has its own cloud computer.",
      },
      {
        topic: "Source",
        rakazo: "Apache-2.0 source on GitHub.",
        other: "Hosted product from OpenAI.",
      },
      {
        topic: "Model",
        rakazo:
          "Bring your own model credentials. Multiple providers are supported, including a custom model server.",
        other: "GPT-6 Astra, according to OpenAI's announcement.",
      },
      {
        topic: "Connections",
        rakazo:
          "Composio or Pipedream Connect, or a Treg, remote MCP, or OpenAPI source you install. Bots also get a sandboxed browser, terminal, files, and a graphical desktop.",
        other:
          "OpenAI says plugins connect a dot to more than 4,000 apps, and those permissions are shared with ChatGPT. The help center says you can also give a dot its own Slack account.",
      },
      {
        topic: "Ongoing work",
        rakazo:
          "Each bot keeps conversations, memory, routines, and history. Routines are readable Markdown and can run on a schedule. A bot can delegate to a peer bot or a short-lived subagent.",
        other:
          "OpenAI says a dot can keep working in the background. Proactive research can read permitted sources and save private notes. The help center says that research cannot send messages, change content through plugins, or control a browser or computer.",
      },
      {
        topic: "Control and availability",
        rakazo:
          "A bot can pause for approval at a boundary you set, and actions are recorded in an audit log. The web, desktop, and mobile clients are available with self-hosting now.",
        other:
          "Built-in rules and Custom Rules say what a dot may do, must ask about, or must not do. Custom Rules cannot turn off core safety checks. The help center says changing a password or transferring money requires you to take over, and Activity View shows ongoing work. The first dot is included with Pro and Business Premium. Dots are not available to users under 18. OpenAI is also previewing specialist dots for organizations.",
      },
    ],
    faq: [
      {
        question: "Is Rakazo a replacement for a dot?",
        answer:
          "No. A dot is an OpenAI agent on an eligible ChatGPT plan. Rakazo is open source software you run yourself, with your own model credentials.",
      },
      {
        question: "Do I need an OpenAI account to use Rakazo?",
        answer:
          "No. OpenAI is one supported model connection, not a requirement. You bring credentials for a provider you choose.",
      },
      {
        question: "Where do the Dots details come from?",
        answer:
          "The Dots column summarizes OpenAI's September 29, 2026 announcement and OpenAI's Dots privacy, security, and safety FAQ. Check those pages before you rely on a specific capability.",
      },
    ],
    sources: DOTS_SOURCES,
  },
  {
    slug: "instinct-alternative",
    name: "Instinct",
    summary: "A hosted personal assistant you text or call, and what is different when you host Rakazo yourself.",
    title: "Open Source Instinct AI Alternative – Rakazo",
    description:
      "Rakazo is an open source, self-hostable platform for persistent AI teammates. Compare it with Instinct, the personal assistant you text or call.",
    h1: "Open source Instinct AI alternative",
    otherName: "Instinct",
    intro: [
      "Instinct is a personal assistant operated by Spear Street Technology, Inc. The homepage says there are no new interfaces: you text or call it, and it can use a phone and a computer the way a person does. Examples on that page include disputing a bill, sending gifts, ordering groceries, scheduling a doctor's appointment, and planning a trip.",
      "Rakazo is open source software for persistent AI teammates. You choose the model and the computer, and you can run the stack yourself. This is a comparison of public descriptions, not a measured benchmark.",
    ],
    rows: [
      {
        topic: "Product",
        rakazo: "Open source platform for persistent AI teammates. Rakazo is in beta.",
        other:
          "A personal assistant. The privacy policy, revised August 26, 2026, calls it an autonomous assistant that thinks, plans, and acts on everyday tasks.",
      },
      {
        topic: "Who runs it",
        rakazo:
          "You do. Self-host with Docker, or point the desktop and mobile apps at a server you operate. Hosted Rakazo Cloud is not generally available.",
        other:
          "Spear Street Technology, Inc., under the Instinct name. The privacy policy describes a hosted service, including third-party hosting. It does not describe installing Instinct on a server you operate.",
      },
      {
        topic: "Source",
        rakazo: "Apache-2.0 source on GitHub.",
        other: "Hosted service. The terms say the company owns the service and the technology that produces its actions.",
      },
      {
        topic: "Model",
        rakazo:
          "Bring your own model credentials. Multiple providers are supported, including a custom model server.",
        other:
          "The privacy policy and terms do not name a public model. They say Instinct may train its models on what you submit unless you opt out in settings, though material flagged for safety review can still be used. Vault materials and Google Workspace data are excluded.",
      },
      {
        topic: "Computer",
        rakazo:
          "Sandboxed browser, terminal, files, and a graphical desktop, on a shared team computer or an isolated private computer. Docker is the default local computer, with optional E2B, Daytona, CreateOS, Box, or a trusted local computer.",
        other:
          "The homepage says Instinct can use a phone and a computer the way a person does. The privacy policy's examples include booking a ride, signing into an account with credentials you provide, and booking a medical appointment.",
      },
      {
        topic: "Connected apps",
        rakazo:
          "Composio or Pipedream Connect, or a Treg, remote MCP, or OpenAPI source you install. Connector credentials are encrypted on the server and are not returned by the API.",
        other:
          "The terms let Instinct act in services you connect, including using a payment method for a purchase. Linking Google Workspace grants Calendar, Gmail, Drive, Docs, Sheets, Slides, and Tasks.",
      },
      {
        topic: "Ongoing work",
        rakazo:
          "Each bot keeps its own conversations, memory, routines, and history. Routines are readable Markdown and can run on a schedule. A bot can delegate to a peer bot or a short-lived subagent.",
        other:
          "The privacy policy says the assistant is designed to be available when you engage it, and that it plans and completes tasks from the permissions you grant.",
      },
      {
        topic: "Approval",
        rakazo:
          "A bot can pause for approval when a task crosses a boundary you set. Actions are recorded in an audit log.",
        other:
          "The terms say Instinct can act on what you send, including purchases, and that you remain responsible for those actions. Confirmation steps may exist but are not promised to prevent an unintended action.",
      },
      {
        topic: "Where you use it",
        rakazo:
          "Web app, Electron desktop app, and Expo mobile app. Voice can speak replies, take dictation, and call a bot, with your own ElevenLabs, OpenAI, Cartesia, or Fish Audio key.",
        other:
          "The homepage says you text or call it. The privacy policy and terms also describe the Instinct website, Mac apps, and mobile apps.",
      },
    ],
    faq: [
      {
        question: "Is Rakazo a replacement for Instinct?",
        answer:
          "No. Instinct is a hosted personal assistant you text or call, operated by Spear Street Technology, Inc. Rakazo is open source software for persistent AI teammates on infrastructure you control. Both can take on tasks beyond a single reply. They differ on hosting, model choice, and who operates the computer.",
      },
      {
        question: "Can I self-host Rakazo?",
        answer:
          "Yes. Self-hosting is available now with published Docker images or a source checkout. Hosted Rakazo Cloud is not generally available.",
      },
      {
        question: "Does Rakazo text, call, or buy things the way Instinct describes?",
        answer:
          "No. Those are Instinct behaviors described on its homepage, privacy policy, and terms. Rakazo's clients are the web app, the Electron desktop app, and the Expo mobile app. A bot can use a browser, terminal, files, and a desktop you run, and it can pause for approval at a boundary you set.",
      },
      {
        question: "Where do the Instinct details come from?",
        answer:
          "The Instinct column summarizes the Instinct homepage, the privacy policy revised August 26, 2026, and the terms of service revised the same day. This page is about the personal assistant at instinct.com. Check those pages before you rely on a specific capability.",
      },
    ],
    sources: INSTINCT_SOURCES,
  },
  {
    slug: "hermes-alternative",
    name: "Hermes Agent",
    summary: "Nous Research's open source agent. Rakazo keeps setup and daily use in chat.",
    title: "Open Source Hermes Agent Alternative – Rakazo",
    description:
      "Rakazo is an open source, self-hosted AI agent with a chat interface. Compare its setup with Hermes Agent, the MIT-licensed agent from Nous Research.",
    h1: "Open source Hermes Agent alternative",
    otherName: "Hermes Agent",
    intro: [
      "Hermes Agent is Nous Research's open source AI agent, released under the MIT license. You can run it on your own machine. The project site also offers optional Nous Portal credits and cloud hosting.",
      "The main difference is simplicity. Like Grok Bot, Rakazo is just chat: you set up the bot and manage it from that chat. Hermes documents a desktop app and a command-line quickstart. Desktop onboarding can reach a first message without the CLI. The quickstart is an installer, a setup wizard, a model command, and config files. Messaging platforms are a separate gateway.",
      "Both are open source and can run on hardware you control. This comparison uses each project's public docs. It is not a measured benchmark.",
    ],
    sections: [
      {
        heading: "Setup",
        paragraphs: [
          "Rakazo's self-host path is the published Docker installer, or the desktop app starting that stack on this computer. You create an account and connect a model. From there it is just chat, on the web, desktop, and mobile apps. A new bot interviews you about the work, and you manage the bot from that chat. Routines are readable Markdown.",
          "Hermes Desktop is a native app on macOS, Windows, and Linux. It shares config, API keys, sessions, skills, and memory with the CLI. The desktop guide says first-run onboarding gets you to a first message in seconds, and Choose provider later skips provider setup. Settings cover providers, models, tools, credentials, MCP servers, the gateway, and sessions. The app starts its own local `hermes serve` backend. That chat does not require the CLI or the web dashboard.",
          "The CLI quickstart is a separate path: a shell install (`install.sh` on Linux, macOS, and WSL2; a PowerShell script on Windows), then `hermes setup` (Quick Setup with Nous Portal, Full Setup, or Blank Slate) and `hermes model`. Secrets go in `~/.hermes/.env` and other settings in `~/.hermes/config.yaml`. The first terminal chat is `hermes` or `hermes --tui`. Telegram, Discord, Slack, WhatsApp, Signal, Email, and other platforms use `hermes gateway setup` and a gateway process you start separately. The desktop guide says that messaging gateway is a different process from the app's local backend.",
        ],
      },
      {
        heading: "Day-to-day management",
        paragraphs: [
          "Day to day, you manage Rakazo from the same chat. Schedules, memory, and approval boundaries stay with that bot. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark. They are not required to use the product.",
          "Hermes Desktop manages providers, models, tools, credentials, and sessions in Settings. The CLI quickstart sends a broken setup through `hermes doctor`, `hermes model`, `hermes setup`, `hermes sessions list`, and `hermes gateway status`. Tool access is `hermes tools`. Cron, skills, and MCP servers are further configuration. Messaging platforms still need that separately running gateway.",
        ],
      },
    ],
    rows: [
      {
        topic: "Setup",
        rakazo:
          "Docker installer or the desktop app's local stack, then an account and a model. After that Rakazo is just chat: a new bot interviews you, and you manage it from the chat.",
        other:
          "Desktop: first-run onboarding in the app, with Choose provider later if you skip a provider. The app shares `~/.hermes/` with the CLI and starts its own local backend. CLI: `hermes setup` and `hermes model`, then `hermes` or `hermes --tui`. Messaging platforms use `hermes gateway setup` and a separate gateway process.",
      },
      {
        topic: "Day-to-day management",
        rakazo:
          "You manage the bot from the same chat on the web, desktop, and mobile apps. Routines are readable Markdown and can run on a schedule. A bot can pause for approval at a boundary you set.",
        other:
          "Desktop settings cover providers, models, tools, credentials, MCP, and sessions. The CLI recovery commands are `hermes doctor`, `hermes model`, `hermes setup`, and `hermes gateway status`. Chat apps need a gateway process kept running apart from the desktop's local backend.",
      },
      {
        topic: "Product",
        rakazo: "Open source platform for persistent AI teammates. Rakazo is in beta.",
        other:
          "Nous Research describes a self-improving agent: it creates skills from experience, keeps memory across sessions, and can run scheduled jobs. The README also documents a terminal UI and a messaging gateway.",
      },
      {
        topic: "Source",
        rakazo: "Apache-2.0 source on GitHub.",
        other: "MIT source on GitHub, built by Nous Research.",
      },
      {
        topic: "Model",
        rakazo:
          "Bring your own model credentials. Multiple providers are supported, including a custom model server. Each bot can use a different model.",
        other:
          "You choose a provider with `hermes model`. The quickstart lists many, including Nous Portal, OpenAI, Anthropic, OpenRouter, Google, a custom OpenAI-compatible endpoint, and local servers such as Ollama and LM Studio. It says a model needs at least 64,000 tokens of context.",
      },
      {
        topic: "Computer",
        rakazo:
          "Sandboxed browser, terminal, files, and a graphical desktop. Docker is the default local computer, with optional E2B, Daytona, CreateOS, Box, or a trusted local computer.",
        other:
          "The README lists seven terminal backends: local, Docker, SSH, Singularity, Modal, Daytona, and Vercel Sandbox. The quickstart shows `hermes config set terminal.backend` for Docker or SSH. The security guide says dangerous-command checks are skipped inside Docker, Singularity, Modal, Daytona, and Vercel Sandbox, because the container is the boundary.",
      },
      {
        topic: "Connections",
        rakazo:
          "Composio or Pipedream Connect, or a Treg, remote MCP, or OpenAPI source you install. Connector credentials are encrypted on the server and are not returned by the API.",
        other:
          "MCP servers are configured in `config.yaml`. The project site also describes web search, browser automation, vision, image generation, and text-to-speech, including a Nous Portal Tool Gateway that bundles several of those.",
      },
      {
        topic: "Where you talk to it",
        rakazo:
          "The Rakazo web, desktop, and mobile apps are the main surface. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark.",
        other:
          "Hermes Desktop is a chat window that shares sessions with the CLI and TUI. The gateway adds Telegram, Discord, Slack, WhatsApp, Signal, Email, and other platforms, and the desktop guide says that gateway is a separate process.",
      },
      {
        topic: "Ongoing work",
        rakazo:
          "Each bot keeps conversations, memory, routines, and history. A bot can delegate to a peer bot or a short-lived subagent.",
        other:
          "The README describes agent-curated memory, skills that can be created after a task, a built-in cron scheduler, and isolated subagents. Scheduled jobs can be delivered back to a connected platform.",
      },
      {
        topic: "Approval",
        rakazo:
          "A bot can pause for approval when a task crosses a boundary you set. Actions are recorded in an audit log.",
        other:
          "The security guide documents approval for dangerous shell commands (`approvals.mode` defaults to smart), file-write checks, and allowlists for who can message the gateway. Container backends skip the dangerous-command check. Cron and other unattended sessions deny those commands unless you change that setting.",
      },
    ],
    faq: [
      {
        question: "Is Rakazo simpler to set up than Hermes Agent?",
        answer:
          "The documented paths are different. Rakazo's self-host guide is a Docker installer, or the desktop app starting that stack, then an account and a model. After that Rakazo is just chat, and you manage the bot from that chat. Hermes Desktop can reach a first message from in-app onboarding without the CLI, and you manage providers and tools in Settings. The CLI quickstart is `hermes setup`, `hermes model`, config files under `~/.hermes/`, and a terminal chat. Messaging apps are an extra gateway process on either path.",
      },
      {
        question: "Is Rakazo a drop-in replacement for Hermes Agent?",
        answer:
          "No. Rakazo does not import Hermes config, skills, or gateway sessions. Both are open source agents you can run yourself. They differ in license, interface, and how much of the setup lives in a chat versus Hermes's CLI and desktop settings.",
      },
      {
        question: "Do both keep the software on my machine?",
        answer:
          "Yes for the software you run. A Rakazo deployment stores its database and bot data on your host. Hermes stores config, memory, and skills on the machine where you install it, by default under `~/.hermes/`. In both cases, prompts go to the model provider you configure. Hermes's site also offers optional Nous Portal and cloud hosting.",
      },
      {
        question: "Where do the Hermes details come from?",
        answer:
          "The Hermes column summarizes the Hermes Agent site, the quickstart, the configuration guide, the security guide, the desktop guide, and the project README on GitHub. This is Nous Research's Hermes Agent, not a different product with the same name. Check those pages before you rely on a specific command.",
      },
    ],
    sources: HERMES_SOURCES,
  },
  {
    slug: "hark-alternative",
    name: "Hark Pro",
    summary: "A hosted personal agent. After install, Rakazo stays in chat on a stack you run.",
    title: "Open Source Hark Pro Alternative – Rakazo",
    description:
      "Rakazo is an open source, self-hosted AI agent with a chat interface. Compare it with Hark Pro, the hosted personal agent at hark.com.",
    h1: "Open source Hark Pro alternative",
    otherName: "Hark Pro",
    intro: [
      "Hark Pro is the personal agent at hark.com, launched October 6, 2026. It is a hosted app on the web, iOS, and Android. The launch article says every feature stays free, with $20 a month for twice the usage and $100 a month for ten times the usage.",
      "Like Grok Bot, Rakazo is just chat: you set up the bot and manage it from that chat. Hark Pro feels like a messaging app. The same article describes Home, Action Buttons, and Panels, Projects as dedicated chats with their own threads, and a cloud computer called Handoff that Hark operates.",
      "Hark introduced Handoff, its computer-use agent, on August 5, 2026. This comparison uses Hark's public pages. It is not a measured benchmark.",
    ],
    rows: [
      {
        topic: "Product",
        rakazo: "Open source platform for persistent AI teammates. Rakazo is in beta.",
        other:
          "Hark Pro, a hosted personal agent launched October 6, 2026, on the web, iOS, and Android. Hark says it remembers what you tell it and can act on the web.",
      },
      {
        topic: "Who runs it",
        rakazo:
          "You do. Self-host with Docker, or point the desktop and mobile apps at a server you operate. Hosted Rakazo Cloud is not generally available.",
        other:
          "The terms name Hark Labs, Inc. as the operator of the hosted service. They do not describe a self-host install, and they restrict reverse engineering the service.",
      },
      {
        topic: "Price",
        rakazo:
          "No seat fee for the open source software. You pay the model and computer providers you use.",
        other:
          "Free, including the features named in the launch article. $20 a month is twice the usage. $100 a month is ten times the usage.",
      },
      {
        topic: "Day-to-day management",
        rakazo:
          "After you connect a model, Rakazo is just chat. You manage the bot from that chat on the web, desktop, and mobile apps. Routines are readable Markdown.",
        other:
          "The launch article describes a messaging-style conversation. Projects are dedicated chats with their own threads. Home, Action Buttons, and Panels sit beside that. The privacy policy says you can review, edit, or delete memory by asking the agent.",
      },
      {
        topic: "Model",
        rakazo:
          "Bring your own model credentials. Multiple providers are supported, including a custom model server. Each bot can use a different model.",
        other:
          "The launch article says Hark is training models. The security page says Hark prioritizes its own models, and that models from vetted third parties keep no data. The terms do not name a public model you can swap. They say Hark may train on what you submit unless you opt out, though feedback and material flagged for safety review can still be used.",
      },
      {
        topic: "Computer",
        rakazo:
          "Sandboxed browser, terminal, files, and a graphical desktop. Docker is the default local computer, with optional E2B, Daytona, CreateOS, Box, or a trusted local computer.",
        other:
          "Handoff, introduced August 5, 2026, is a virtual computer with a browser, files, and a terminal. The October 6 launch article says it can run up to 6 browsers at once and log in on your behalf. Hark operates that computer.",
      },
      {
        topic: "Connected apps",
        rakazo:
          "Composio or Pipedream Connect, or a Treg, remote MCP, or OpenAPI source you install. Connector credentials are encrypted on the server and are not returned by the API.",
        other:
          "The launch article names Google and Outlook APIs, files, external databases, and MCP. Passwords and cards sit in Secured by Hark, which Hark says it cannot see inside.",
      },
      {
        topic: "Ongoing work",
        rakazo:
          "Each bot keeps conversations, memory, routines, and history. A bot can delegate to a peer bot or a short-lived subagent.",
        other:
          "Memory persists unless you ask Hark to forget. You can create scheduled tasks. Action Buttons are suggested from what Hark knows, and a tap runs that action.",
      },
      {
        topic: "Approval",
        rakazo:
          "A bot can pause for approval when a task crosses a boundary you set. Actions are recorded in an audit log.",
        other:
          "The homepage says Hark checks in before an action that needs approval. The security page says tasks start from consent, you can watch the computer-use agent, and you can cancel. The launch article says that if you allow it, Hark can finish some tasks on its own.",
      },
      {
        topic: "Where you use it",
        rakazo:
          "The Rakazo web, desktop, and mobile apps. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark.",
        other:
          "The web app, iOS, and Android. The privacy policy says you work through one ongoing conversation, and that inputs can include chat, voice, and file uploads. You must be 18 or older.",
      },
    ],
    faq: [
      {
        question: "Is Rakazo a replacement for Hark Pro?",
        answer:
          "No. Hark Pro is a hosted personal agent at hark.com, operated by Hark Labs, Inc. Rakazo is open source software for persistent AI teammates on infrastructure you control. Both can take on tasks from a conversation. They differ on hosting, model choice, and who operates the computer.",
      },
      {
        question: "Can I self-host Rakazo?",
        answer:
          "Yes. Self-hosting is available now with published Docker images or a source checkout. Hosted Rakazo Cloud is not generally available.",
      },
      {
        question: "How do you manage each one day to day?",
        answer:
          "After a Docker or desktop install and a model connection, Rakazo is just chat, like Grok Bot, and you manage the bot from that chat. Hark Pro feels like a messaging app. The launch article adds Home, Action Buttons, and Panels, and Projects as dedicated chats with their own threads.",
      },
      {
        question: "Does Rakazo order things or run Handoff the way Hark describes?",
        answer:
          "No. Ordering, bill pay, and Handoff are Hark behaviors described on its site. Rakazo's clients are the web app, the Electron desktop app, and the Expo mobile app. A bot can use a browser, terminal, files, and a desktop you run, and it can pause for approval at a boundary you set.",
      },
      {
        question: "Where do the Hark Pro details come from?",
        answer:
          "The Hark Pro column summarizes the homepage, the Introducing Hark Pro article published October 6, 2026, the Introducing Hark Handoff article published August 5, 2026, the privacy policy last updated October 1, 2026, the terms posted June 30, 2026, and the security page. This page is about Hark Pro at hark.com. Check those pages before you rely on a specific capability.",
      },
    ],
    sources: HARK_SOURCES,
  },
];

export function alternativePath(alternative: Pick<Alternative, "slug">): string {
  return `/${alternative.slug}/`;
}

export type HubCard = {
  href: string;
  name: string;
  h1: string;
  summary: string;
};

/** Pages that already have their own route. They stay out of `ALTERNATIVES` so `[slug]` does not publish them again. */
const DEDICATED_HUB_CARDS: readonly HubCard[] = [
  {
    href: GROK_ALTERNATIVE_PATH,
    name: "Grok Bot",
    h1: GROK_ALTERNATIVE_H1,
    summary: "xAI's hosted bots, and what is different when you host Rakazo yourself.",
  },
  {
    href: OPENCLAW_ALTERNATIVE_PATH,
    name: "OpenClaw",
    h1: OPENCLAW_H1,
    summary: "An open source agent you run yourself. Rakazo stays in chat; OpenClaw's docs add a gateway and a config file.",
  },
];

export const HUB_CARDS: readonly HubCard[] = [
  ...ALTERNATIVES.map((page) => ({
    href: alternativePath(page),
    name: page.name,
    h1: page.h1,
    summary: page.summary,
  })),
  ...DEDICATED_HUB_CARDS,
];

export function faqPageSchema(faq: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function alternativeMarkdown(alternative: Alternative): string {
  const lines = [
    `# ${alternative.h1}`,
    "",
    ...alternative.intro.flatMap((paragraph) => [paragraph, ""]),
    ...(alternative.sections ?? []).flatMap((section) => [
      `## ${section.heading}`,
      "",
      ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ]),
    `Public descriptions as of ${COMPARED_ON}.`,
    "",
    "## Comparison",
    "",
    `| Topic | Rakazo | ${alternative.otherName} |`,
    "| --- | --- | --- |",
    ...alternative.rows.map(
      (row) => `| ${cell(row.topic)} | ${cell(row.rakazo)} | ${cell(row.other)} |`,
    ),
    "",
    "## Why open source and self-hosted",
    "",
    ...OPEN_SOURCE_REASONS.map((reason) => `- ${reason}`),
    "",
    `## ${GET_STARTED.heading}`,
    "",
    GET_STARTED.copy,
    "",
    `- [${GET_STARTED.docsLabel}](${DOCS_URL})`,
    `- [${GET_STARTED.githubLabel}](${GITHUB_URL})`,
    "",
    "## FAQ",
    "",
    ...alternative.faq.flatMap((item) => [`### ${item.question}`, "", item.answer, ""]),
    "## Sources",
    "",
    ...alternative.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ];
  return lines.join("\n");
}

