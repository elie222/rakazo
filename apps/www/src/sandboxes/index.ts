import { SITE_URL } from "../site";
import { boat } from "./boat";
import { daytona } from "./daytona";
import { docker } from "./docker";
import { e2b } from "./e2b";
import { kubernetes } from "./kubernetes";
import { novita } from "./novita";
import { railway } from "./railway";
import { COMPUTER_PROVIDERS_DOCS_PATH, SANDBOXES_PATH, SANDBOXES_UPDATED, sandboxPath } from "./shared";
import type { Sandbox, SandboxSection } from "./types";
import { wuying } from "./wuying";
import { yourComputer } from "./your-computer";

export * from "./shared";
export type { Sandbox, SandboxImage, SandboxSection } from "./types";

/** Display order everywhere sandboxes are listed. */
export const SANDBOXES: readonly Sandbox[] = [
  boat,
  e2b,
  daytona,
  novita,
  railway,
  wuying,
  docker,
  kubernetes,
  yourComputer,
];

export const SANDBOXES_HUB = {
  title:
    "Best sandboxes for AI agents in 2026: Boat, E2B, Daytona, Novita, Railway, Docker and Kubernetes",
  description:
    "Where should an AI agent's computer run? A comparison of hosted sandboxes, Docker, Kubernetes and your own Mac or PC, from the team behind Rakazo.",
  h1: "Best sandboxes for AI agents in 2026",
  intro: [
    "An AI agent that only chats can't do much. To clean up an inbox, research a list of companies or fix a bug, it needs a computer: a browser it can sign in with, files it can keep, and a terminal to run things in. A sandbox is that computer, kept apart from yours so a mistake stays contained.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer. You can watch its screen and take over at any moment. Where that computer runs is your choice: a hosted sandbox, a container on your own server, a Kubernetes cluster, or your own Mac or PC. This page compares every option Rakazo supports.",
  ],
  scene: {
    bot: "Inbox Manager",
    color: "#6A6BF5",
    where: "Computer on any sandbox",
    ask: "inbox got away from me over the weekend, sweep it?",
    reply: "on it. 41 unread since friday. archiving the noise, drafting the rest.",
    task: "Sweeping Gmail back to Friday.",
    screen: {
      host: "mail.google.com",
      title: "Inbox: 5 drafts parked",
      lines: ["41 threads read", "26 archived · 9 replied", "Nora's renewal held"],
    },
  },
  choose: [
    {
      heading: "You want it hosted",
      text: "[Boat](/sandboxes/boat/) is what Rakazo Cloud runs its own bot computers on: full Linux VMs where every bot keeps its own Chrome logins. [E2B](/sandboxes/e2b/) is the option Rakazo's live computer tests run on, and pauses idle computers instead of deleting them. [Novita](/sandboxes/novita/) pauses with memory, so a bot comes back to the same open programs. [Daytona](/sandboxes/daytona/) keeps each computer's disk and suits teams already using it.",
    },
    {
      heading: "You don't want a cloud account",
      text: "[Docker](/sandboxes/docker/) is the default when you [self-host Rakazo](/self-hosted-ai-agent/): each bot gets a locked-down container with a desktop, on your own machine. [Kubernetes](/sandboxes/kubernetes/) runs one pod per computer on a cluster you already have, with gVisor or Kata if you want VM-level isolation.",
    },
    {
      heading: "You want one bill",
      text: "[Railway](/sandboxes/railway/) runs Rakazo, its database and the bot computers from one template. The trade-off is that computers are rebuilt from saved files after they stop, so open programs don't survive.",
    },
    {
      heading: "You need Windows, or you're in mainland China",
      text: "[Wuying](/sandboxes/wuying/) lets bots use a Windows cloud computer you already have on Alibaba Cloud, which also works where other sandbox providers are hard to reach.",
    },
    {
      heading: "You want your bots on your real apps",
      text: "The Rakazo desktop app can let bots use [your own computer](/sandboxes/your-computer/), with your files, apps and logins. That isn't a sandbox, so only turn it on for bots you'd trust unattended.",
    },
  ],
  faq: [
    {
      question: "What is an AI agent sandbox?",
      answer:
        "An isolated computer where an agent can run commands, use a browser and change files without touching your own machine. In Rakazo it's the bot's computer, which you can watch and take over.",
    },
    {
      question: "Do I need a sandbox provider to run Rakazo?",
      answer:
        "No. When you [self-host](/self-hosted-ai-agent/), Docker computers work out of the box with no cloud account. Hosted providers are optional.",
    },
    {
      question: "Can I switch providers later?",
      answer:
        "Yes. Rakazo keeps its own saved copy of each bot's workspace, so a new computer on another provider starts from the last saved version. Let bots finish and their computers stop before you switch, so recent changes are saved first. Software installed outside the workspace doesn't move.",
    },
    {
      question: "Which sandbox is the safest?",
      answer:
        "Hosted sandboxes and Kubernetes with gVisor or Kata keep a bot furthest from your own systems. Docker containers are hardened but share your server's kernel. Using your own computer gives a bot everything you can reach, by design.",
    },
  ],
} as const;

/** Absolute links for agent Markdown, which is read outside the site. */
function absolute(text: string): string {
  return text.replace(/\]\((\/[^)]*)\)/g, `](${SITE_URL}$1)`);
}

function sectionMarkdown(section: SandboxSection): string[] {
  return [
    `## ${section.heading}`,
    "",
    ...(section.paragraphs ?? []).flatMap((paragraph) => [absolute(paragraph), ""]),
    ...(section.bullets?.length ? [...section.bullets.map((item) => `- ${absolute(item)}`), ""] : []),
    ...(section.steps?.length
      ? [...section.steps.map((step, index) => `${index + 1}. ${absolute(step)}`), ""]
      : []),
  ];
}

/** Markdown twin of a sandbox page, for agents and `.md` requests. */
export function sandboxMarkdown(sandbox: Sandbox): string {
  return [
    `# ${sandbox.h1}`,
    "",
    ...sandbox.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${SANDBOXES_UPDATED}.`,
    "",
    ...sandbox.sections.flatMap(sectionMarkdown),
    "## FAQ",
    "",
    ...sandbox.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
    "## More sandboxes for AI agents",
    "",
    `- [All sandboxes compared](${SITE_URL}${SANDBOXES_PATH})`,
    ...SANDBOXES.filter((other) => other.slug !== sandbox.slug).map(
      (other) => `- [${other.name}](${SITE_URL}${sandboxPath(other.slug)}): ${other.bestFor}`,
    ),
    "",
    "## Sources",
    "",
    ...sandbox.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ].join("\n");
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|");
}

/** Markdown twin of the sandboxes hub. */
export function sandboxesHubMarkdown(): string {
  return [
    `# ${SANDBOXES_HUB.h1}`,
    "",
    ...SANDBOXES_HUB.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${SANDBOXES_UPDATED}.`,
    "",
    "## Compared",
    "",
    "| Sandbox | Runs on | Keeps between sessions | Best for |",
    "| --- | --- | --- | --- |",
    ...SANDBOXES.map(
      (sandbox) =>
        `| [${cell(sandbox.name)}](${SITE_URL}${sandboxPath(sandbox.slug)}) | ${cell(sandbox.runsOn)} | ${cell(sandbox.keeps)} | ${cell(sandbox.bestFor)} |`,
    ),
    "",
    "## How to choose",
    "",
    ...SANDBOXES_HUB.choose.flatMap((item) => [`### ${item.heading}`, "", absolute(item.text), ""]),
    `[Computer providers guide](${SITE_URL}${COMPUTER_PROVIDERS_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...SANDBOXES_HUB.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
  ].join("\n");
}
