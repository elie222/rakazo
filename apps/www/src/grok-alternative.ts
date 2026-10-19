import { DOCS_URL, GITHUB_URL, SITE_URL } from "./site";
import { CLAUDE_CHATGPT_SUBSCRIPTION_FAQ } from "./subscription-faq";

export const GROK_ALTERNATIVE_PATH = "/grok-bot-alternative/";

export const GROK_ALTERNATIVE_TITLE =
  "Open Source Grok Bot Alternative (Self-Hosted) – Rakazo";

export const GROK_ALTERNATIVE_DESCRIPTION =
  "Rakazo is an open source, self-hosted Grok Bot alternative. Run persistent AI teammates on your machine, with your model keys, under the Apache-2.0 license.";

export const GROK_ALTERNATIVE_H1 = "Open source, self-hosted Grok Bot alternative";

export const GROK_INTRO = [
  "Rakazo is just chat. You create a bot and manage it from that conversation. Routines, memory, and approval boundaries stay with the bot.",
  "Grok Bot is xAI's hosted product for that kind of work: named bots, a computer they can use, routines, and approvals. Rakazo is the version you can run yourself. The source is Apache-2.0, the server is yours, and you bring the model key.",
] as const;

export const COMPARE_ROWS = [
  {
    topic: "Source",
    rakazo: "Apache-2.0. The application source is on GitHub.",
    grok: "The Grok Bot app does not publish source you can run. Grok Build and the Grok-1 weights are separate open-source releases.",
  },
  {
    topic: "Self-hosting",
    rakazo: "Docker Compose images, or a source checkout, on a machine you control.",
    grok: "A cloud computer on your account. An optional local computer can run approved commands. The docs do not describe deploying the service yourself.",
  },
  {
    topic: "Data and computers",
    rakazo:
      "You run the deployment. Team computers are shared; private computers are isolated. Connector credentials are encrypted on your server and are never returned by the API.",
    grok: "Requires cloud data storage. Bots on one account share one cloud computer, including files and logins. Training opt-out follows the Cursor account settings.",
  },
  {
    topic: "Model",
    rakazo:
      "Sign in with Claude Pro/Max, ChatGPT Plus/Pro, or SuperGrok, or bring a key. Documented providers include OpenAI, Anthropic, Google, OpenRouter, Vercel AI Gateway, Cursor, custom servers, and a local model (Ollama, LM Studio). Rakazo does not pay the model bill.",
    grok: "Included with paid Cursor plans and SuperGrok subscriptions. The Grok Bot docs do not describe connecting your own model provider.",
  },
  {
    topic: "Price",
    rakazo:
      "No license fee to self-host. You pay your model provider and the computer you run. Hosted Rakazo Cloud is not generally available.",
    grok: "Included with paid individual Cursor plans, Cursor Teams, and SuperGrok subscriptions. SuperGrok is listed at $30/month and includes Grok Bot access. Plans include weekly usage; extra usage can be billed. The free plan on the pricing page does not list Grok Bot.",
  },
  {
    topic: "Apps",
    rakazo: "Web, Electron desktop, and Expo mobile.",
    grok: "Desktop apps for macOS, Windows, and Linux, plus iOS and Android.",
  },
] as const;

export const COMPARE_NOTE =
  "The Grok Bot column follows xAI's public Grok Bot docs and pricing page.";

export const GROK_SOURCES = [
  { label: "Grok Bot overview", href: "https://docs.x.ai/grok-bot/overview" },
  { label: "Grok Bot FAQ", href: "https://docs.x.ai/grok-bot/faq" },
  { label: "xAI pricing", href: "https://x.ai/pricing" },
  { label: "Grok Build source", href: "https://github.com/xai-org/grok-build" },
  { label: "Grok-1 weights", href: "https://github.com/xai-org/grok-1" },
  { label: "OpenMausBot", href: "https://www.openmausbot.com/" },
  { label: "OpenMausBot docs", href: "https://docs.openmausbot.com/docs" },
  { label: "OpenMausBot providers", href: "https://docs.openmausbot.com/docs/providers" },
  { label: "OpenMausBot source", href: "https://github.com/milind-soni/OpenMausBot" },
  { label: "OpenMuse", href: "https://www.copilotkit.ai/openmuse" },
  { label: "OpenMuse source", href: "https://github.com/CopilotKit/openmuse" },
] as const;

export const INSTALL_COMMAND = `mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh`;

export const SELF_HOST_LEAD =
  "Published images need Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.";

export const SELF_HOST_AFTER = [
  "On this computer, open http://127.0.0.1:5173, create an account, and connect a model. That address is only on the machine running Rakazo. Local Docker computers are on by default.",
  "On a server, run the installer with --prepare-only, set the public HTTPS origin, and create the owner account before anyone else can reach it. The self-hosting guide covers that setup. The desktop app can install the stack on this computer, or connect to an instance you already run.",
] as const;

export const GROK_UPDATED = "October 12, 2026";

export type RichPart =
  | { kind: "text"; value: string }
  | { kind: "link"; label: string; href: string };

const linkPattern = () => /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Split a paragraph that may contain markdown links. */
export function richParts(value: string): RichPart[] {
  const parts: RichPart[] = [];
  let last = 0;
  for (const match of value.matchAll(linkPattern())) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", value: value.slice(last, index) });
    parts.push({ kind: "link", label: match[1] ?? "", href: match[2] ?? "" });
    last = index + match[0].length;
  }
  if (last < value.length || parts.length === 0) {
    parts.push({ kind: "text", value: value.slice(last) });
  }
  return parts;
}

export type GrokFigure = {
  webp: string;
  avif: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
};

export const GROK_CHAT_FIGURE: GrokFigure = {
  webp: "/graphics/grok/chat.webp",
  avif: "/graphics/grok/chat.avif",
  width: 1200,
  height: 800,
  alt: "Rakazo chat with the Inbox bot. The sidebar lists Inbox, Chief, and Sales. The message asks the bot to file demo mail and not send anything.",
  caption: "The chat. The roster is the sidebar, and you manage the bot from this conversation.",
};

export const GROK_ROUTINE_FIGURE: GrokFigure = {
  webp: "/graphics/grok/routine.webp",
  avif: "/graphics/grok/routine.avif",
  width: 1200,
  height: 800,
  alt: "A routine editor for a weekday inbox check, with the instruction written as text and a weekday 8:00 AM schedule.",
  caption: "A routine is the instruction and the schedule.",
};

export const GROK_MODELS_FIGURE: GrokFigure = {
  webp: "/graphics/grok/models.webp",
  avif: "/graphics/grok/models.avif",
  width: 1280,
  height: 900,
  alt: "Rakazo model settings with Anthropic selected, Claude Sonnet 5.5 in the model menu, and a button to sign in with Claude Pro/Max. The provider list also shows OpenAI Codex and xAI.",
  caption: "Sign in with Claude Pro/Max, ChatGPT Plus/Pro, or SuperGrok. An API key works too.",
};

export const GROK_SECTIONS = [
  {
    heading: "What Grok Bot is",
    paragraphs: [
      "Grok Bot is xAI's hosted product for persistent bots. The public docs describe named bots, a computer they can use, routines, and approvals. The computer in the default setup is a cloud computer on your account. Bots on that account share it, including files and logins. An optional local computer can run approved commands on the machine in front of you. That local computer is not the same thing as installing the Grok Bot service on a server you operate. The docs do not describe that install.",
      "The model comes with the plan. The Grok Bot docs do not describe connecting OpenAI, Anthropic, a custom server, or a local model. Training opt-out follows the Cursor account settings. Desktop apps exist for macOS, Windows, and Linux, plus iOS and Android.",
      "Price follows the plan, not a separate Grok Bot seat. The docs and pricing page used here say Grok Bot is included with paid individual Cursor plans, Cursor Teams, and SuperGrok subscriptions. SuperGrok is listed at $30 a month and includes Grok Bot access. Plans include weekly usage, and extra usage can be billed. The free plan on the pricing page does not list Grok Bot.",
      "Two other xAI releases are easy to mix up with the bot. Grok Build, the coding-agent CLI, is Apache-2.0. The older Grok-1 model weights were released under Apache-2.0. Neither of those is the Grok Bot service, and neither one is a self-hosted Grok Bot.",
    ],
  },
  {
    heading: "What Rakazo keeps from that shape",
    paragraphs: [
      "Rakazo is an open source AI agent for persistent teammates, and a self-hosted AI assistant. It is in beta. Each bot keeps conversations, memory, routines, and history. It can use a browser, a terminal, files, and a graphical desktop, and it can hand work to another bot or a short-lived subagent. The clients are the web app, the Electron desktop app, and the Expo mobile app.",
      "Like Grok Bot, Rakazo is just chat once it is running. You set up the bot and manage it from that chat. A new bot interviews you about the work. Routines are readable Markdown and can run on a schedule. A bot can pause for approval when a task crosses a boundary you set, and actions are recorded in an audit log. Optional connectors can attach Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark. They are not required.",
      "The parts that are not Grok Bot are the ones you operate. The license is Apache-2.0. You self-host with published Docker images or from source. Hosted Rakazo Cloud is not generally available. Sign in with Claude Pro/Max, ChatGPT Plus/Pro, or SuperGrok, or bring a key for OpenAI, Anthropic, Google, OpenRouter, Vercel AI Gateway, an OpenAI-compatible endpoint, or a local model server such as Ollama or LM Studio. Rakazo does not pay the model bill. Each bot can use a different model. Connector credentials are encrypted on your server and are not returned by the API.",
      "Computers are separate from the chat product. Local Docker is the default. E2B, Daytona, CreateOS, and Box are optional remote computers. An explicit desktop provider can run on the host, and it is not the default. Team computers are shared. Private computers are isolated. That split is the opposite of Grok Bot's shared cloud computer for every bot on the account.",
    ],
  },
  {
    heading: "Setup, then the chat",
    paragraphs: [
      "Published images need Docker Engine 26 or newer, the Compose plugin, curl, and OpenSSL. You do not need Node.js for that path. A source checkout needs a supported Node.js line and pnpm, plus Docker. The desktop app can install the published images on this computer, or connect to an instance you already run.",
      "On this computer, open the local web app, create an account, and connect a model. The first registered user becomes the deployment owner. Local Docker computers are on by default. From there the product is the chat. You do not keep a gateway process running, and you do not edit a config file to change the bot's routines.",
      "On a server, the installer can stop before startup so you can set the public HTTPS origin and create the owner account before anyone else can reach it. The self-hosting guide covers backups, upgrades, secrets, and restricted networks. Voice, if you want it, uses a key you bring for ElevenLabs, OpenAI, Cartesia, or Fish Audio.",
      "The [self-hosted AI agent](/self-hosted-ai-agent/) page is that install. [How to self-host an AI agent](/blog/self-host-an-ai-agent/) walks through the published images.",
    ],
  },
] as const;

export const GROK_OTHER_LEAD =
  "Hosted assistants and open source agents are both on the [alternatives roundup](/alternatives/). [OpenClaw vs Hermes Agent vs Rakazo](/blog/openclaw-vs-hermes-vs-rakazo/) compares the three you run yourself, and [best open source AI agents in 2026](/blog/best-open-source-ai-agents-2026/) includes libraries as well as apps.";

function altShot(file: string, alt: string) {
  return {
    webp: `/graphics/grok/alts/${file}.webp`,
    avif: `/graphics/grok/alts/${file}.avif`,
    width: 1280,
    height: 800,
    alt,
  };
}

export const GROK_OTHER_ALTERNATIVES = [
  {
    href: "/muse-alternative/",
    label: "Meta Muse",
    note: "Meta's hosted agent, introduced September 8, 2026, on a virtual machine Meta operates. You talk to it in the Muse app or WhatsApp.",
    image: altShot("muse", "Meta Muse homepage"),
  },
  {
    href: "/dots-alternative/",
    label: "OpenAI Dots",
    note: "Always-on agents on eligible ChatGPT plans, announced September 29, 2026. OpenAI says each dot has its own cloud computer.",
    image: altShot("dots", "OpenAI Dots"),
  },
  {
    href: "/instinct-alternative/",
    label: "Instinct",
    note: "The hosted assistant at instinct.com that you text or call. Spear Street Technology, Inc. operates it.",
    image: altShot("instinct", "Instinct homepage"),
  },
  {
    href: "/hark-alternative/",
    label: "Hark Pro",
    note: "The hosted personal agent at hark.com, launched October 6, 2026, with a free tier. $20 a month is twice the usage, and $100 a month is ten times the usage.",
    image: altShot("hark", "Hark Pro"),
  },
  {
    href: "/openclaw-alternative/",
    label: "OpenClaw",
    note: "An MIT-licensed agent you run yourself. The docs add a Gateway and a config file.",
    image: altShot("openclaw", "OpenClaw homepage"),
  },
  {
    href: "/hermes-alternative/",
    label: "Hermes Agent",
    note: "Nous Research's MIT-licensed agent, with a desktop app and a separate messaging gateway.",
    image: altShot("hermes", "Hermes Agent homepage"),
  },
  {
    href: "https://www.openmausbot.com/",
    label: "OpenMausBot",
    note: "An Apache-2.0 desktop app for macOS, Windows, and Ubuntu. Its [docs](https://docs.openmausbot.com/docs/providers) say bots can run a signed-in agent CLI, or Mistral from an API key with no CLI, and that application data stays on your machine.",
    image: altShot("openmausbot", "OpenMausBot homepage"),
  },
  {
    href: "https://www.copilotkit.ai/openmuse",
    label: "OpenMuse",
    note: "CopilotKit's MIT-licensed personal agent, with a chat, a persistent browser, and an optional Linux terminal. The project site says those surfaces run in the alpha.",
    image: altShot("openmuse", "OpenMuse homepage"),
  },
  {
    href: "/alternatives/",
    label: "All comparisons",
    note: "The 2026 roundup, with the license, price, and setup table.",
  },
] as const;

export const GROK_ALTERNATIVE_FAQ = [
  {
    question: "Is Grok Bot open source?",
    answer:
      "Grok Bot, the hosted teammate app, does not publish its source for you to run. xAI has open-sourced other software: Grok Build, the coding-agent CLI, is Apache-2.0, and the older Grok-1 model weights were released under Apache-2.0. Those projects are not the Grok Bot service. Rakazo is Apache-2.0, and the application source is public on GitHub.",
  },
  {
    question: "Can I self-host Grok Bot?",
    answer:
      "The Grok Bot docs describe a cloud computer assigned to your account. They also describe an optional local computer, where a bot runs approved commands on the machine in front of you. They do not describe installing the Grok Bot service on a server you operate. Rakazo can be self-hosted.",
  },
  {
    question: "How is Rakazo different from Grok Bot?",
    answer:
      "Both are persistent bots that can use a computer, sign in to tools, keep context, and run routines. Grok Bot hosts that computer for you and comes with paid Cursor plans and SuperGrok subscriptions. Rakazo is open source: you host it, you choose the model, and team computers and private computers stay separate. Hosted Rakazo Cloud is not generally available yet.",
  },
  {
    question: "Is Rakazo just chat, like Grok Bot?",
    answer:
      "After the install, yes. You create an account, connect a model, and manage the bot from that chat. A new bot interviews you. Routines, memory, and approval boundaries stay with the bot. Rakazo is that chat plus the computer you run. Grok Bot is also a chat for named bots. The difference is who hosts the service and who picks the model.",
  },
  CLAUDE_CHATGPT_SUBSCRIPTION_FAQ,
  {
    question: "What are the other alternatives?",
    answer:
      "Meta Muse, OpenAI Dots, Instinct, and Hark Pro are hosted assistants. OpenClaw and Hermes Agent are open source agents you can run yourself, with a gateway and a config file in their docs. OpenMausBot is an Apache-2.0 desktop app; its docs say bots can run a signed-in agent CLI, or Mistral from an API key with no CLI, and that application data stays on your machine. OpenMuse is CopilotKit's MIT-licensed personal agent, with a chat, a persistent browser, and an optional Linux terminal, and those surfaces run in the alpha. The comparisons page lists licenses, prices, and setup side by side. None of them imports a Grok Bot account.",
  },
] as const;

export function grokAlternativeStructuredData(pageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${pageUrl}#faq`,
    url: pageUrl,
    mainEntity: GROK_ALTERNATIVE_FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

function absoluteHref(href: string): string {
  return href.startsWith("http") ? href : `${SITE_URL}${href}`;
}

/** The saved markdown page has no site to resolve a root-relative link against. */
function absoluteMarkdown(value: string): string {
  return value.replaceAll(
    linkPattern(),
    (_match, label: string, href: string) => `[${label}](${absoluteHref(href)})`,
  );
}

function figureMarkdown(figure: GrokFigure): string {
  return `![${figure.alt}](${SITE_URL}${figure.webp})\n\n${figure.caption}`;
}

function sectionMarkdown(section: (typeof GROK_SECTIONS)[number]): string {
  const figure =
    section.heading === "What Rakazo keeps from that shape"
      ? GROK_ROUTINE_FIGURE
      : section.heading === "Setup, then the chat"
        ? GROK_MODELS_FIGURE
        : null;
  const body = section.paragraphs.map((paragraph) => absoluteMarkdown(paragraph)).join("\n\n");
  return `## ${section.heading}\n\n${body}${figure ? `\n\n${figureMarkdown(figure)}` : ""}`;
}

export function grokAlternativeMarkdown(): string {
  const comparison = [
    "| Topic | Rakazo | Grok Bot |",
    "| --- | --- | --- |",
    ...COMPARE_ROWS.map((row) => `| ${row.topic} | ${row.rakazo} | ${row.grok} |`),
  ].join("\n");
  const sources = GROK_SOURCES.map((source) => `- [${source.label}](${source.href})`).join(
    "\n",
  );
  const faq = GROK_ALTERNATIVE_FAQ.map(
    (item) => `### ${item.question}\n\n${absoluteMarkdown(item.answer)}`,
  ).join("\n\n");

  return `# ${GROK_ALTERNATIVE_H1}

Updated ${GROK_UPDATED}.

${GROK_INTRO.map((paragraph) => absoluteMarkdown(paragraph)).join("\n\n")}

${figureMarkdown(GROK_CHAT_FIGURE)}

${GROK_SECTIONS.map((section) => sectionMarkdown(section)).join("\n\n")}

## How they compare

${comparison}

${COMPARE_NOTE}

${sources}

## Self-host Rakazo

${SELF_HOST_LEAD}

\`\`\`bash
${INSTALL_COMMAND}
\`\`\`

${SELF_HOST_AFTER.join("\n\n")}

- [Self-hosting guide](${DOCS_URL})
- [Source code](${GITHUB_URL})

## Other alternatives

${absoluteMarkdown(GROK_OTHER_LEAD)}

${GROK_OTHER_ALTERNATIVES.map((item) => {
    const line = `- [${item.label}](${absoluteHref(item.href)}) — ${absoluteMarkdown(item.note)}`;
    return "image" in item
      ? `![${item.image.alt}](${SITE_URL}${item.image.webp})\n\n${line}`
      : line;
  }).join("\n\n")}

## FAQ

${faq}

- [Rakazo](${SITE_URL}/)
- [Sitemap](${SITE_URL}/sitemap-index.xml)
`;
}

export const GROK_ALTERNATIVE_MARKDOWN = grokAlternativeMarkdown();
