import { SITE_URL } from "./site";
import { CLAUDE_CHATGPT_SUBSCRIPTION_FAQ } from "./subscription-faq";

export const GROK_ALTERNATIVE_PATH = "/grok-bot-alternative/";

export const GROK_ALTERNATIVE_TITLE =
  "Grok Bot alternatives (open source and hosted) – Rakazo";

export const GROK_ALTERNATIVE_DESCRIPTION =
  "Open source and hosted Grok Bot alternatives: Rakazo, OpenClaw, Hermes Agent, Meta Muse, OpenAI Dots, Instinct, Hark Pro, and Claude Duet.";

export const GROK_ALTERNATIVE_H1 = "Grok Bot alternatives (open source and hosted)";

export const GROK_INTRO = [
  "Grok Bot is xAI's hosted product for named bots, a computer they can use, routines, and approvals. The public docs describe a cloud computer on your account. They do not describe installing the service yourself or connecting your own model provider.",
  "Below are alternatives, open source and hosted. [Rakazo, the open source Grok Bot alternative](/), is one of them: Apache-2.0 software you can run on your own machine, with a model key you bring.",
] as const;

export const GROK_HOWTO = [
  "Choose an agent you run yourself when the computer and the model key should stay with you. Rakazo is Apache-2.0: you host it, you bring the model key, and you manage the bot from chat. OpenClaw is an MIT-licensed agent you run yourself, and its docs add a Gateway and a config file. Hermes Agent is MIT-licensed, with a desktop app that can reach a first message without the command line, and a separate gateway for messaging apps.",
  "Choose a hosted assistant when you do not want to install the service. Grok Bot comes with paid Cursor plans and SuperGrok. Meta Muse runs on a virtual machine Meta operates. OpenAI Dots sit on eligible ChatGPT plans. Instinct is the assistant you text or call. Claude Duet comes with Claude Pro and Max in the US, on a computer Anthropic operates. Hark Pro has a free tier. $20 a month is twice the usage, and $100 a month is ten times the usage.",
  "The [alternatives roundup](/alternatives/) lists license, price, and setup side by side. [OpenClaw vs Hermes Agent vs Rakazo](/blog/openclaw-vs-hermes-vs-rakazo/) compares the three you run yourself, and [best open source AI agents in 2026](/blog/best-open-source-ai-agents-2026/) includes libraries as well as apps.",
] as const;

export const GROK_SOURCES = [
  { label: "Grok Bot overview", href: "https://docs.x.ai/grok-bot/overview" },
  { label: "Grok Bot FAQ", href: "https://docs.x.ai/grok-bot/faq" },
  { label: "xAI pricing", href: "https://x.ai/pricing" },
  { label: "Grok Build source", href: "https://github.com/xai-org/grok-build" },
  { label: "Grok-1 weights", href: "https://github.com/xai-org/grok-1" },
] as const;

export const GROK_UPDATED = "October 31, 2026";

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

export type GrokCardImage = {
  webp: string;
  avif: string;
  width: number;
  height: number;
  alt: string;
};

export type GrokListCard = {
  label: string;
  href: string;
  note: string;
  image: GrokCardImage;
  caption?: string;
};

function altShot(file: string, alt: string): GrokCardImage {
  return {
    webp: `/graphics/grok/alts/${file}.webp`,
    avif: `/graphics/grok/alts/${file}.avif`,
    width: 1280,
    height: 800,
    alt,
  };
}

function figureImage(figure: GrokFigure): GrokCardImage {
  return {
    webp: figure.webp,
    avif: figure.avif,
    width: figure.width,
    height: figure.height,
    alt: figure.alt,
  };
}

export const GROK_ALTERNATIVES: readonly GrokListCard[] = [
  {
    label: "Rakazo",
    href: "/",
    note: "Suits someone who wants a persistent bot on a machine they control, with a model key they bring, managed from chat. The license is Apache-2.0. [Rakazo, the open source Grok Bot alternative](/).",
    image: figureImage(GROK_CHAT_FIGURE),
    caption: GROK_CHAT_FIGURE.caption,
  },
  {
    label: "OpenClaw",
    href: "/openclaw-alternative/",
    note: "Suits someone who wants an MIT-licensed agent on their own machine and will run a Gateway and a config file. [OpenClaw comparison](/openclaw-alternative/).",
    image: altShot("openclaw", "OpenClaw homepage"),
  },
  {
    label: "Hermes Agent",
    href: "/hermes-alternative/",
    note: "Suits someone who wants Nous Research's MIT-licensed agent, including a desktop app that can reach a first message without the command line. Messaging apps use a separate gateway. [Hermes Agent comparison](/hermes-alternative/).",
    image: altShot("hermes", "Hermes Agent homepage"),
  },
  {
    label: "Meta Muse",
    href: "/muse-alternative/",
    note: "Suits someone who wants Meta's hosted agent in the Muse app or WhatsApp. It runs on a virtual machine Meta operates, and Meta introduced it on September 8, 2026. [Meta Muse comparison](/muse-alternative/).",
    image: altShot("muse", "Meta Muse homepage"),
  },
  {
    label: "OpenAI Dots",
    href: "/dots-alternative/",
    note: "Suits someone on an eligible ChatGPT plan who wants OpenAI's always-on agents. OpenAI announced them on September 29, 2026, and says each dot has its own cloud computer. [OpenAI Dots comparison](/dots-alternative/).",
    image: altShot(
      "dots",
      "OpenAI page titled Introducing dots, dated September 29, 2026, with a button to create a dot.",
    ),
  },
  {
    label: "Instinct",
    href: "/instinct-alternative/",
    note: "Suits someone who wants to text or call a hosted assistant. Spear Street Technology, Inc. operates the assistant at instinct.com. [Instinct comparison](/instinct-alternative/).",
    image: altShot("instinct", "Instinct homepage"),
  },
  {
    label: "Hark Pro",
    href: "/hark-alternative/",
    note: "Suits someone who wants the hosted personal agent at hark.com, launched October 6, 2026, with a free tier. $20 a month is twice the usage, and $100 a month is ten times the usage. [Hark Pro comparison](/hark-alternative/).",
    image: altShot(
      "hark",
      "Hark preview image with the word hark in white on a blue and coral sky.",
    ),
  },
  {
    label: "Claude Duet",
    href: "/claude-duet-alternative/",
    note: "Suits someone with Claude Pro or Max in the US who wants Anthropic's research-preview agent. It runs on a cloud computer Anthropic operates, and Anthropic released it on October 21, 2026. [Claude Duet comparison](/claude-duet-alternative/).",
    image: altShot("claude-duet", "Claude Duet"),
  },
];

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
      "Both are persistent bots that can use a computer, sign in to tools, keep context, and run routines. Grok Bot hosts that computer for you and comes with paid Cursor plans and SuperGrok subscriptions. Rakazo is open source: you host it or use Rakazo Cloud, in beta, you choose the model, and team computers and private computers stay separate.",
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
      "Meta Muse, OpenAI Dots, Instinct, Claude Duet, and Hark Pro are hosted assistants. OpenClaw and Hermes Agent are open source agents you can run yourself, with a gateway and a config file in their docs. The comparisons page lists licenses, prices, and setup side by side. None of them imports a Grok Bot account.",
  },
] as const;

export function grokAlternativeStructuredData(pageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: GROK_ALTERNATIVE_TITLE,
        description: GROK_ALTERNATIVE_DESCRIPTION,
        mainEntity: { "@id": `${pageUrl}#list` },
      },
      {
        "@type": "ItemList",
        "@id": `${pageUrl}#list`,
        name: GROK_ALTERNATIVE_H1,
        description: GROK_ALTERNATIVE_DESCRIPTION,
        url: pageUrl,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: GROK_ALTERNATIVES.length,
        itemListElement: GROK_ALTERNATIVES.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.label,
          url: absoluteHref(item.href),
        })),
      },
      {
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
      },
    ],
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

export function grokAlternativeMarkdown(): string {
  const cards = GROK_ALTERNATIVES.map((item) => {
    const image = `![${item.image.alt}](${SITE_URL}${item.image.webp})`;
    const caption = item.caption ? `\n\n${item.caption}` : "";
    return `### ${item.label}\n\n${image}${caption}\n\n${absoluteMarkdown(item.note)}`;
  }).join("\n\n");
  const sources = GROK_SOURCES.map((source) => `- [${source.label}](${source.href})`).join(
    "\n",
  );
  const faq = GROK_ALTERNATIVE_FAQ.map(
    (item) => `### ${item.question}\n\n${absoluteMarkdown(item.answer)}`,
  ).join("\n\n");

  return `# ${GROK_ALTERNATIVE_H1}

Updated ${GROK_UPDATED}.

${GROK_INTRO.map((paragraph) => absoluteMarkdown(paragraph)).join("\n\n")}

${cards}

${figureMarkdown(GROK_ROUTINE_FIGURE)}

${figureMarkdown(GROK_MODELS_FIGURE)}

## How to choose

${GROK_HOWTO.map((paragraph) => absoluteMarkdown(paragraph)).join("\n\n")}

${sources}

## FAQ

${faq}

- [Rakazo, the open source Grok Bot alternative](${SITE_URL}/)
- [Sitemap](${SITE_URL}/sitemap-index.xml)
`;
}

export const GROK_ALTERNATIVE_MARKDOWN = grokAlternativeMarkdown();
