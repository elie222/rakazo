import type { Alternative, FaqItem } from "./alternatives";
import { ALTERNATIVES, ALTERNATIVES_HUB, COMPARED_ON, alternativePath } from "./alternatives";
import { GROK_ALTERNATIVE_H1, GROK_ALTERNATIVE_PATH } from "./grok-alternative";
import { OPENCLAW_H1 } from "./guide";
import { OPENCLAW_ALTERNATIVE_PATH, SELF_HOST_GUIDE_PATH, SITE_URL } from "./site";

export const ROUNDUP_TITLE = ALTERNATIVES_HUB.title;

export const ROUNDUP_H1 = ALTERNATIVES_HUB.h1;

export const ROUNDUP_DESCRIPTION = ALTERNATIVES_HUB.description;

export const ROUNDUP_TLDR = [
  ALTERNATIVES_HUB.intro,
  "Rakazo is the open source option you run yourself. Like Grok Bot, it is just chat once it is running: you set up a bot and manage it from that chat. You bring the model key. The license is Apache-2.0, and there is no seat fee.",
  "Grok Bot, Meta Muse, OpenAI Dots, Instinct, and Hark Pro are hosted. You do not install their service. Grok Bot comes with paid Cursor plans and SuperGrok. Muse runs on a virtual machine Meta operates. Dots sit on eligible ChatGPT plans. Instinct is the assistant you text or call. Hark Pro has a free tier, with $20 and $100 monthly tiers for more usage.",
  "OpenClaw and Hermes Agent are also open source and self-hosted. Their docs describe installers, config files, and a gateway. Hermes Desktop can reach a first chat without the command line. OpenClaw can chat while its Gateway runs in the terminal.",
] as const;

export const ROUNDUP_COLUMNS = [
  "License",
  "Self-host",
  "Your model",
  "Price",
  "Setup",
  "Managed from chat",
] as const;

export type RoundupRow = {
  product: string;
  href: string;
  license: string;
  selfHost: string;
  model: string;
  price: string;
  setup: string;
  chat: string;
};

export const ROUNDUP_ROWS: readonly RoundupRow[] = [
  {
    product: "Rakazo",
    href: "/",
    license: "Apache-2.0",
    selfHost: "Yes. Docker images or a source checkout.",
    model: "Yes. Your key, including a local server.",
    price: "No seat fee. You pay the model and computer.",
    setup: "Docker or the desktop app, then an account and a model.",
    chat: "Yes. You manage the bot from the chat.",
  },
  {
    product: "Grok Bot",
    href: GROK_ALTERNATIVE_PATH,
    license: "Hosted. No source for the bot service.",
    selfHost: "No. Cloud computer. Optional local commands.",
    model: "No. Included with the plan.",
    price: "Paid Cursor plans and SuperGrok at $30 a month.",
    setup: "Install the app. The service stays hosted.",
    chat: "Yes. Named bots, routines, and approvals.",
  },
  {
    product: "Meta Muse",
    href: "/muse-alternative/",
    license: "Hosted service from Meta.",
    selfHost: "No. Muse Secure VM is Meta's cloud machine.",
    model: "No. The launch post names Muse Spark.",
    price: "The Muse posts used here do not list a price.",
    setup: "Muse app or WhatsApp, in the US and Canada.",
    chat: "Yes, in the app or WhatsApp.",
  },
  {
    product: "OpenAI Dots",
    href: "/dots-alternative/",
    license: "Hosted product from OpenAI.",
    selfHost: "No. Each dot has a cloud computer OpenAI runs.",
    model: "No. The announcement names GPT-6 Astra.",
    price: "Eligible Pro, Business Premium, and Enterprise plans.",
    setup: "A ChatGPT plan that includes Dots. Not under 18.",
    chat: "Yes. A dot can keep working after you leave.",
  },
  {
    product: "Instinct",
    href: "/instinct-alternative/",
    license: "Hosted. The cited pages do not publish source.",
    selfHost: "No install is described.",
    model: "No public model is named. Safety review can still train.",
    price: "The cited pages do not list a price.",
    setup: "Text or call. The policy also names apps.",
    chat: "Yes. You text or call.",
  },
  {
    product: "Hark Pro",
    href: "/hark-alternative/",
    license: "Hosted. The terms restrict reverse engineering.",
    selfHost: "No install is described.",
    model: "No. Hark trains its own models.",
    price: "Free. $20 a month is 2×. $100 a month is 10×.",
    setup: "Web, iOS, or Android app.",
    chat: "Yes. Projects are separate chats.",
  },
  {
    product: "OpenClaw",
    href: OPENCLAW_ALTERNATIVE_PATH,
    license: "MIT",
    selfHost: "Yes. You run the Gateway.",
    model: "Yes, including a server you host.",
    price: "No software fee. You pay models and the machine.",
    setup: "CLI installer and a wizard.",
    chat: "Chat apps and a Control UI, plus a config file.",
  },
  {
    product: "Hermes Agent",
    href: "/hermes-alternative/",
    license: "MIT",
    selfHost: "Yes. It defaults to the machine you install it on.",
    model: "Yes, including local. 64,000 token minimum.",
    price: "MIT software. Optional Nous Portal credits.",
    setup: "Desktop onboarding, or a CLI wizard.",
    chat: "Desktop is a chat. Messaging needs a gateway.",
  },
];

export type RoundupCard = {
  name: string;
  href: string;
  heading: string;
  paragraphs: readonly string[];
};

const CARD_BODY: Record<string, readonly string[]> = {
  "muse-alternative": [
    "Meta introduced Muse on September 8, 2026. You talk to it in the Muse app or on WhatsApp, and Meta says it keeps working after you close the app. The computer is Muse Secure VM, a cloud machine Meta operates. The launch post names Muse Spark, so you do not bring a model key. Meta says it checks before sensitive actions such as sending email or paying, and that you can opt out of using interactions to train Meta's models. The posts used here do not list a price. Rakazo is the opposite on hosting: you run the stack, and you pick the model.",
  ],
  "dots-alternative": [
    "OpenAI announced Dots on September 29, 2026. A dot is an always-on agent with its own cloud computer, and OpenAI says it uses GPT-6 Astra. The first dot is included with eligible Pro and Business Premium plans. Enterprise is in the rollout. Dots are not available under 18. A rules list says what the dot may do, must ask about, or must not do, and Custom Rules cannot turn off core safety checks. Changing a password or transferring money requires you to take over. Rakazo does not include a dot. OpenAI is one model connection you can choose.",
  ],
  "instinct-alternative": [
    "Instinct, on this page, is the personal assistant at instinct.com that you text or call. The homepage describes it using your phone and computer the way a person would, with examples such as a bill, gifts, or a trip. The privacy policy and terms were revised August 26, 2026. They do not name a public model. They say Instinct may train on what you submit unless you opt out, and that material flagged for safety review can still be used. Vault materials and Google Workspace data are excluded. Terms let it act in connected services, including a payment method. Rakazo does not text, call, or buy things that way.",
  ],
  "hermes-alternative": [
    "Hermes Agent is Nous Research's MIT-licensed agent, and you can run it on your own machine. The desktop app shares config, keys, sessions, and memory with the command-line install. First-run onboarding can reach a first message without the CLI. The app starts its own local backend. Telegram, Discord, and Slack use a gateway process you start separately. The quickstart says a model needs at least 64,000 tokens of context. Like Grok Bot, Rakazo's ongoing management stays in the chat.",
  ],
  "hark-alternative": [
    "Hark Pro is the personal agent at hark.com, launched October 6, 2026. It is a hosted web, iOS, and Android app. Every feature in that article stays free. Twenty dollars a month is twice the usage, and one hundred dollars a month is ten times. The article describes a messaging-style app. Projects are dedicated chats with their own threads, and Home, Action Buttons, and Panels sit beside that. Hark introduced Handoff on August 5, 2026. It is a virtual computer with a browser, files, and a terminal. The October 6 article says it can run up to six browsers at once, and Hark operates that computer. Training opt-out has exceptions for feedback and safety review. Rakazo uses a computer you run, and you bring the model.",
  ],
};

const DEDICATED_CARDS: readonly RoundupCard[] = [
  {
    name: "Rakazo",
    href: SELF_HOST_GUIDE_PATH,
    heading: "Open source AI agent you run yourself",
    paragraphs: [
      "Rakazo is an open source AI agent for persistent teammates. It is in beta. The clients are the web app, the Electron desktop app, and the Expo mobile app. You bring a model key, including a local server, and each bot can use a different model. The default computer is local Docker. Optional computers include E2B, Daytona, CreateOS, Box, and a trusted local computer. Like Grok Bot, Rakazo is just chat once it is running: a new bot interviews you, and you manage schedules, memory, and approvals from that chat. Routines are readable Markdown. There is no seat fee. Hosted Rakazo Cloud is not generally available.",
    ],
  },
  {
    name: "Grok Bot",
    href: GROK_ALTERNATIVE_PATH,
    heading: GROK_ALTERNATIVE_H1,
    paragraphs: [
      "Grok Bot is xAI's hosted product for named bots that can use a computer, keep routines, and pause for approval. The docs describe a cloud computer on your account, shared by the bots on that account. They do not describe installing the service yourself or connecting your own model provider. Grok Build and the older Grok-1 weights are separate open source releases, not this service. Grok Bot is included with paid Cursor plans and SuperGrok, listed at $30 a month. The free plan on the pricing page does not list it. Rakazo is this shape you host, with a model key you bring.",
    ],
  },
];

const OPENCLAW_CARD: RoundupCard = {
  name: "OpenClaw",
  href: OPENCLAW_ALTERNATIVE_PATH,
  heading: OPENCLAW_H1,
  paragraphs: [
    "OpenClaw is an MIT-licensed agent you run yourself, stewarded by the OpenClaw Foundation. The getting-started guide installs a CLI and runs a wizard. The Gateway can stay in that terminal so you can chat before openclaw gateway install, the later background service. Later changes go through openclaw configure and a JSON config file. Chat apps are the main surface, alongside the Control UI. After Docker or the desktop app, Rakazo is just chat, managed from that chat, like Grok Bot.",
  ],
};

/** Display order only. Membership comes from `ALTERNATIVES`. */
const PREFERRED_CARD_ORDER = [
  "muse-alternative",
  "dots-alternative",
  "instinct-alternative",
  "hark-alternative",
  "hermes-alternative",
] as const;

function alternativeCard(page: Alternative): RoundupCard {
  return {
    name: page.name,
    href: alternativePath(page),
    heading: page.h1,
    paragraphs: CARD_BODY[page.slug] ?? [page.summary, ...page.intro],
  };
}

function orderedAlternativeCards(): RoundupCard[] {
  const rank = new Map<string, number>(PREFERRED_CARD_ORDER.map((slug, index) => [slug, index]));
  return [...ALTERNATIVES]
    .sort((left, right) => {
      const leftRank = rank.get(left.slug) ?? PREFERRED_CARD_ORDER.length;
      const rightRank = rank.get(right.slug) ?? PREFERRED_CARD_ORDER.length;
      return leftRank - rightRank || left.slug.localeCompare(right.slug);
    })
    .map(alternativeCard);
}

const alternativeCards = orderedAlternativeCards();
const hermesCards = alternativeCards.filter((card) => card.href === "/hermes-alternative/");
const middleCards = alternativeCards.filter((card) => card.href !== "/hermes-alternative/");

export const ROUNDUP_CARDS: readonly RoundupCard[] = [
  DEDICATED_CARDS[1],
  ...middleCards,
  DEDICATED_CARDS[0],
  OPENCLAW_CARD,
  ...hermesCards,
];

export const ROUNDUP_TIMELINE = [
  {
    when: "August 5, 2026",
    what: "Hark introduced Handoff, the computer-use agent that later sits inside Hark Pro.",
  },
  {
    when: "August 26, 2026",
    what: "Instinct revised its privacy policy and terms. Those pages do not give a product launch date. This roundup does not invent one.",
  },
  {
    when: "September 8, 2026",
    what: "Meta introduced Muse, a personal agent on a virtual machine Meta operates.",
  },
  {
    when: "September 23, 2026",
    what: "Meta's Connect recap added Muse for Mac, which can drive apps on that Mac with permission.",
  },
  {
    when: "September 29, 2026",
    what: "OpenAI introduced Dots. Meta also posted about Muse for small businesses. The Muse posts used here still do not list a price.",
  },
  {
    when: "October 6, 2026",
    what: "Hark launched Hark Pro: a hosted web, iOS, and Android app, free, with $20 and $100 usage tiers.",
  },
  {
    when: "October 7, 2026",
    what: "This roundup. OpenClaw and Hermes Agent are ongoing open source projects. Their docs do not give a single launch day, so they are not pinned to one.",
  },
] as const;

export const ROUNDUP_CHANGELOG = [
  "Added Hark Pro and the August 5 Handoff date.",
  "Added Instinct and Hermes Agent beside Muse, Dots, Grok Bot, and OpenClaw.",
  "Named Meta Muse, OpenAI Dots, Instinct AI, and Hermes Agent in the comparison titles.",
] as const;

export const ROUNDUP_HOWTO = [
  "Choose Rakazo when the agent should live on hardware you control, the model key should be one you bring, and the daily surface should stay a chat. That is the Grok Bot shape without the hosted service. The cost is the install: Docker or the desktop app, then an account and a model. After that, routines, memory, and approvals stay in the chat.",
  "Choose Grok Bot when you already pay for Cursor or SuperGrok and you want xAI to host the computer. Choose Meta Muse for Meta's agent in the Muse app or WhatsApp, on a VM Meta runs. Choose OpenAI Dots when the agent should sit on an eligible ChatGPT plan and follow OpenAI's rules for what it may do alone. Choose Instinct when you want to text or call a hosted assistant. Choose Hark Pro for a hosted conversation with a free tier and a cloud computer Hark operates.",
  "Choose OpenClaw when the assistant should live in chat apps you already use, and you are willing to run a Gateway and a config file. Choose Hermes Agent for MIT-licensed software and a desktop app that can reach a first message without the CLI. Messaging apps on Hermes still need a separate gateway. Rakazo does not import a Grok Bot account, a Muse VM, a dot, an Instinct thread, or a Hark vault. OpenClaw documents a Hermes migration for config, memory, skills, and, if you accept it, credentials. Read the linked page before you rely on a price, a country, or a connector.",
] as const;

export const ROUNDUP_FAQ: readonly FaqItem[] = [
  {
    question: "Which of these can I self-host?",
    answer:
      "Rakazo, OpenClaw, and Hermes Agent. Rakazo publishes Docker images and a source checkout. OpenClaw's guide has you run the Gateway. Hermes installs on your machine, and the desktop app can start its own local backend. Grok Bot, Muse, Dots, Instinct, and Hark Pro are hosted. Their pages do not describe installing the service yourself. Hosted Rakazo Cloud is not generally available.",
  },
  {
    question: "Which let me bring my own model?",
    answer:
      "Rakazo, OpenClaw, and Hermes Agent, including a local or compatible server. Grok Bot's docs do not describe your own provider. Muse's launch post names Muse Spark. Dots use GPT-6 Astra. Instinct's privacy policy and terms do not name a public model. Hark says it trains its own models and prioritizes them.",
  },
  {
    question: "Is Rakazo just chat, like Grok Bot?",
    answer:
      "Yes, after it is running. You install with Docker or the desktop app, create an account, and connect a model. A new bot interviews you, and you manage it from that chat. Grok Bot is also a chat for named bots. OpenClaw adds a command-line setup and a Gateway. Hermes Desktop can reach a first message without the CLI, and messaging apps use a separate gateway. Hark Pro, Muse, Dots, and Instinct are conversations too, on services you do not host.",
  },
  {
    question: "Is this a ranking?",
    answer:
      "No. The title lists the agents people compare in 2026. The table and the cards use each project's public description. They do not measure quality, speed, or how often a task succeeds. Where a price cell says the cited pages do not list one, that is the claim. Check the linked source before you rely on a detail.",
  },
  {
    question: "Where do the dates come from?",
    answer:
      "Muse's launch post is September 8, 2026, and the Connect recap is September 23, 2026. Dots were announced September 29, 2026. Hark introduced Handoff on August 5, 2026, and launched Hark Pro on October 6, 2026. Instinct's privacy policy and terms were revised August 26, 2026, which is not a launch date. Grok Bot, OpenClaw, and Hermes Agent are compared from their current docs without a single launch day.",
  },
];

export function roundupStructuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ItemList",
        name: ROUNDUP_TITLE,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: ROUNDUP_CARDS.length,
        itemListElement: ROUNDUP_CARDS.map((card, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: card.name,
          url: new URL(card.href, SITE_URL).toString(),
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: ROUNDUP_FAQ.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
    ],
  };
}

export function roundupVisibleText(): string {
  return [
    ROUNDUP_H1,
    ROUNDUP_DESCRIPTION,
    ...ROUNDUP_TLDR,
    ...ROUNDUP_ROWS.flatMap((row) => [
      row.product,
      row.license,
      row.selfHost,
      row.model,
      row.price,
      row.setup,
      row.chat,
    ]),
    ...ROUNDUP_CARDS.flatMap((card) => [card.heading, card.name, ...card.paragraphs]),
    ...ROUNDUP_TIMELINE.flatMap((item) => [item.when, item.what]),
    ...ROUNDUP_CHANGELOG,
    ...ROUNDUP_HOWTO,
    ...ROUNDUP_FAQ.flatMap((item) => [item.question, item.answer]),
    `Updated ${COMPARED_ON}.`,
  ].join(" ");
}

export function roundupWordCount(): number {
  return roundupVisibleText().split(/\s+/).filter(Boolean).length;
}

export function roundupMarkdown(): string {
  const table = [
    `| Product | ${ROUNDUP_COLUMNS.join(" | ")} |`,
    `| --- | ${ROUNDUP_COLUMNS.map(() => "---").join(" | ")} |`,
    ...ROUNDUP_ROWS.map(
      (row) =>
        `| ${row.product} | ${row.license} | ${row.selfHost} | ${row.model} | ${row.price} | ${row.setup} | ${row.chat} |`,
    ),
  ];
  return [
    `# ${ROUNDUP_H1}`,
    "",
    ROUNDUP_DESCRIPTION,
    "",
    `Updated ${COMPARED_ON}.`,
    "",
    ...ROUNDUP_CHANGELOG.map((line) => `- ${line}`),
    "",
    "## TL;DR",
    "",
    ...ROUNDUP_TLDR.flatMap((paragraph) => [paragraph, ""]),
    "## Comparison",
    "",
    ...table,
    "",
    "## The agents",
    "",
    ...ROUNDUP_CARDS.flatMap((card) => [
      `### ${card.name}`,
      "",
      ...card.paragraphs.flatMap((paragraph) => [paragraph, ""]),
      `[${card.heading}](${new URL(card.href, SITE_URL).toString()})`,
      "",
    ]),
    "## Launch timeline",
    "",
    ...ROUNDUP_TIMELINE.map((item) => `- **${item.when}.** ${item.what}`),
    "",
    "## How to choose",
    "",
    ...ROUNDUP_HOWTO.flatMap((paragraph) => [paragraph, ""]),
    "## FAQ",
    "",
    ...ROUNDUP_FAQ.flatMap((item) => [`### ${item.question}`, "", item.answer, ""]),
  ].join("\n");
}
