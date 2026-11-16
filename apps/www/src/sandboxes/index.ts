import type { SourceLink } from "../alternatives";
import { absolute, articleMarkdown, cell, sectionMarkdown } from "../provider-article/markdown";
import type { ArticleHub, ArticleLink, ArticleSection } from "../provider-article/types";
import { SITE_URL } from "../site";
import { boat } from "./boat";
import { HOSTED_SANDBOXES_TABLE } from "./compare";
import { daytona } from "./daytona";
import { docker } from "./docker";
import { e2b } from "./e2b";
import { instabox } from "./instabox";
import { kubernetes } from "./kubernetes";
import { novita } from "./novita";
import { railway } from "./railway";
import {
  BOAT,
  BOAT_RAKAZO,
  COMPUTER_PROVIDERS_DOCS_PATH,
  DAYTONA_CREDIT,
  E2B_CREDIT,
  E2B_PRO_FEE,
  INSTABOX,
  KUBERNETES_NODE_FITS,
  MONTH_HOURS,
  NOVITA_CREDIT,
  PRICES_NOTE,
  PRICING,
  RATES,
  SANDBOXES_PATH,
  SANDBOXES_UPDATED,
  SERVERS,
  WORKDAY_HOURS,
  WUYING,
  aboutUsd,
  boatMonthly,
  dockerComputersFit,
  euro,
  hourly,
  instaboxCreditHours,
  instaboxHour,
  instaboxProMonthly,
  instaboxShape,
  macMiniMonthly,
  monthly,
  railwayAppMonthly,
  railwayComputerMonthly,
  rateUsd,
  sandboxPath,
  usd,
  wuyingPayAsYouGo,
  wuyingUnlimited,
} from "./shared";
import type { Sandbox } from "./types";
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
  instabox,
  railway,
  wuying,
  docker,
  kubernetes,
  yourComputer,
];

const perSecondRow = (rate: (typeof RATES)[keyof typeof RATES]) => [
  usd(monthly(rate, WORKDAY_HOURS)),
  usd(monthly(rate, MONTH_HOURS)),
];
const About = (amount: number) => `A${aboutUsd(amount).slice(1)}`;
const boatBeatsE2bHours = Math.round(BOAT.minimum / hourly(RATES.e2b) / 10) * 10;
const hostedHourly = [RATES.novita, RATES.e2b].map((rate) => hourly(rate));
const hostedWorkday = [RATES.novita, RATES.e2b].map((rate) => monthly(rate, WORKDAY_HOURS));
const instaboxShapeLabel = instaboxShape();
const instaboxHourly = instaboxHour();
const instaboxCredit = instaboxCreditHours();

/** Hub sections after the comparison table: prices, the wider market, and isolation. */
const HUB_SECTIONS: readonly ArticleSection[] = [
  {
    heading: "Pricing compared",
    id: "pricing",
    paragraphs: [
      `Every price on these pages is for one person's bots, which share one computer by default: 2 vCPU and 4 GB of memory, enough for a Linux desktop, Chromium and a terminal, running 4 hours a workday (${WORKDAY_HOURS} hours a month) or around the clock (${MONTH_HOURS} hours). Rakazo gives each person one team computer per space, plus one for each bot you give a computer of its own, so for a space where N people use bots, multiply by N. Rakazo stops or pauses a hosted computer after 10 minutes without use, so you pay for roughly the hours bots work. Where a provider or Rakazo can't use that size, the row says which size it prices.`,
      `On Rakazo Cloud you don't pay a sandbox provider: computers run on Boat and come with the plan, and the [pricing page](/pricing/) lists the computer hours each plan includes. The table is for a self-hosted Rakazo, where you bring your own provider.`,
    ],
    table: {
      caption: "What a bot computer costs on each option Rakazo supports",
      columns: ["Option", "How you pay", "Free to start", `${WORKDAY_HOURS} hours a month`, "Around the clock"],
      rows: [
        {
          topic: "[Boat](/sandboxes/boat/)",
          cells: [
            `Per second, $${BOAT.minimum} monthly minimum`,
            "7-day trial, 25 hours",
            `${usd(boatMonthly(BOAT.small.hour, WORKDAY_HOURS))}, the minimum`,
            `${usd(boatMonthly(BOAT.small.hour, MONTH_HOURS))}, the minimum`,
          ],
        },
        {
          topic: "[E2B](/sandboxes/e2b/)",
          cells: [
            `Per second. Pro plan $${E2B_PRO_FEE} a month`,
            `$${E2B_CREDIT} one-time credit`,
            usd(monthly(RATES.e2b, WORKDAY_HOURS)),
            `${usd(monthly(RATES.e2b, MONTH_HOURS))}. Hobby sessions end hourly; Pro (${usd(monthly(RATES.e2b, MONTH_HOURS) + E2B_PRO_FEE)}) allows 24 hours`,
          ],
        },
        {
          topic: "[Daytona](/sandboxes/daytona/)",
          cells: ["Per second, no plan fee", `$${DAYTONA_CREDIT} credit`, ...perSecondRow(RATES.daytona)],
        },
        {
          topic: "[Novita](/sandboxes/novita/)",
          cells: ["Per second, no plan fee", `$${NOVITA_CREDIT} credit after a survey`, ...perSecondRow(RATES.novita)],
        },
        {
          topic: "[InstaBox](/sandboxes/instabox/)",
          cells: [
            `Per second. Pro plan $${INSTABOX.proFee} a month, returned as usage credit`,
            "Free plan for one computer",
            `${usd(instaboxProMonthly(WORKDAY_HOURS))} on Pro, the fee, at ${instaboxShapeLabel}, the size Rakazo uses`,
            `${usd(instaboxProMonthly(MONTH_HOURS))} on Pro`,
          ],
        },
        {
          topic: "[Railway](/sandboxes/railway/)",
          cells: [
            "Per second for CPU and memory used, from $5 a month",
            "$5 trial credit",
            `${About(railwayComputerMonthly(WORKDAY_HOURS))} at typical use, plus ${aboutUsd(railwayAppMonthly)} for the app and database`,
            `${About(railwayComputerMonthly(MONTH_HOURS))} for the computer`,
          ],
        },
        {
          topic: "[Wuying](/sandboxes/wuying/)",
          cells: [
            "Hourly or monthly, plus disk",
            "Alibaba Cloud promotions vary",
            `${About(wuyingPayAsYouGo(WORKDAY_HOURS))} at ${WUYING.size.vcpus} vCPU / ${WUYING.size.gb} GiB, the closest published size`,
            `${About(wuyingUnlimited)} on the unlimited plan`,
          ],
        },
        {
          topic: "[Docker](/sandboxes/docker/)",
          cells: [
            "Your own server",
            "Free software",
            `A ${euro(SERVERS.hetznerCx43)} server fits Rakazo and about ${dockerComputersFit(16)} computers`,
            "Same",
          ],
        },
        {
          topic: "[Kubernetes](/sandboxes/kubernetes/)",
          cells: [
            "Your nodes, plus a control-plane fee on some clouds",
            "Free software",
            `A $${SERVERS.digitalOcean16} DigitalOcean node fits about ${KUBERNETES_NODE_FITS} computers`,
            "Same",
          ],
        },
        {
          topic: "[Your computer](/sandboxes/your-computer/)",
          cells: ["Nothing extra", "Free", "Electricity", `${About(macMiniMonthly(MONTH_HOURS))} for a Mac mini`],
        },
      ],
      note: `${PRICES_NOTE} Usage before free credits. Rakazo can't run Boat at 2 vCPU / 4 GB: self-hosted installs use ${BOAT_RAKAZO.vcpus} vCPU / ${BOAT_RAKAZO.gb} GB machines, which cost ${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))} and ${usd(boatMonthly(BOAT_RAKAZO.hour, MONTH_HOURS))}, and larger Rakazo Cloud plans use [larger ones](/sandboxes/boat/). Each option's page shows the rates and assumptions behind its numbers.`,
    },
    bullets: [
      "For a few hours a day, per-second providers are cheapest. InstaBox has the lowest hourly rates here, just under Boat's, and a free plan for one computer, but more computers need its Pro plan. Of the providers with no plan fee, Novita has the lowest rate, and E2B and Daytona charge the same as each other.",
      `Boat's $${BOAT.minimum} minimum covers about ${Math.floor(BOAT.minimum / BOAT_RAKAZO.hour)} hours of the bigger computer self-hosted Rakazo uses, and it covers every computer on the account, so it is cheaper than E2B or Daytona once your computers run more than about ${boatBeatsE2bHours} hours a month between them, and by far around the clock.`,
      `InstaBox's Pro fee works the same way: the $${INSTABOX.proFee} comes back as usage credit, enough for about ${instaboxCredit} hours of the ${instaboxShapeLabel} computer Rakazo uses there, shared by every computer on the account.`,
      "A server you rent for Docker costs the same whether bots work or not. It's the cheapest way to run many computers, if you're happy to look after it.",
    ],
  },
  {
    heading: "Hosted sandboxes compared, including ones Rakazo doesn't support",
    paragraphs: [
      "Most sandboxes that come up as E2B alternatives are built for running code, not a desktop a person can watch. Modal, Vercel Sandbox, Northflank and Blaxel are good at that, and the table includes them for reference, but Rakazo doesn't support them. Rakazo also works with CreateOS and boxd, which don't have their own page here; the [computer providers guide](/docs/self-host-sandbox-providers/) covers them.",
    ],
    table: HOSTED_SANDBOXES_TABLE,
    bullets: [
      "None of the code-first sandboxes ships a desktop for a person to watch and take over, keeps each bot's browser logins apart, or saves a workspace that survives a switch of provider. Rakazo adds those on every provider it supports.",
      "Session caps matter for agents. E2B's Hobby plan, Novita's free tier and Vercel's Hobby plan end a session within an hour, so a bot on a long research task needs a paid plan or a provider without a cap.",
      "Daytona closed its source in June 2026. E2B is now the main open source hosted sandbox, and Northflank the main one that runs in your own cloud.",
    ],
  },
  {
    heading: "Isolation: containers, gVisor and microVMs",
    paragraphs: [
      "How strongly a sandbox separates a bot from everything else depends on what sits between them. Containers share the host's kernel, so a kernel bug can let a process out. gVisor puts a kernel written in user space in the way. A microVM gives every sandbox its own small kernel behind a hypervisor. Stronger boundaries cost a little speed and, on your own hardware, need virtualization support.",
    ],
    table: {
      caption: "Isolation in AI agent sandboxes",
      columns: ["Boundary", "Who uses it", "Good for", "Trade-off"],
      rows: [
        {
          topic: "Container",
          cells: [
            "[Docker](/sandboxes/docker/), [Kubernetes](/sandboxes/kubernetes/) by default, [Daytona](/sandboxes/daytona/) by default",
            "Your own bots on your own server",
            "Shares the host's kernel",
          ],
        },
        {
          topic: "gVisor",
          cells: [
            "Modal, GKE Sandbox, [Kubernetes](/sandboxes/kubernetes/) with a runtime class",
            "Stronger isolation without a hypervisor",
            "Slower system calls",
          ],
        },
        {
          topic: "microVM: Firecracker, Kata, Cloud Hypervisor",
          cells: [
            "[E2B](/sandboxes/e2b/), [InstaBox](/sandboxes/instabox/), CreateOS, boxd, Vercel Sandbox, Northflank, [Kubernetes](/sandboxes/kubernetes/) with Kata",
            "Other people's bots and public instances",
            "Needs KVM on your own hardware",
          ],
        },
        {
          topic: "Full VM",
          cells: [
            "[Boat](/sandboxes/boat/), [Railway](/sandboxes/railway/), [Wuying](/sandboxes/wuying/)",
            "Long-lived computers",
            "Slower to start than a microVM",
          ],
        },
        {
          topic: "None",
          cells: [
            "[Your computer](/sandboxes/your-computer/)",
            "Work that needs your real apps",
            "A bot can reach everything you can",
          ],
        },
      ],
    },
  },
];

const HUB_SOURCES: readonly SourceLink[] = [
  PRICING.boat,
  PRICING.e2b,
  PRICING.daytona,
  PRICING.novita,
  PRICING.instabox,
  PRICING.railway,
  PRICING.wuying,
  PRICING.createos,
  PRICING.modal,
  PRICING.vercel,
  PRICING.northflank,
  PRICING.blaxel,
  PRICING.hetzner,
  PRICING.digitalocean,
  { label: "DigitalOcean Kubernetes pricing", href: "https://www.digitalocean.com/pricing/kubernetes" },
  PRICING.rakazo,
];

export const SANDBOXES_HUB = {
  title: "Best AI agent sandboxes in 2026: pricing and comparison of Boat, E2B, Daytona, Modal, Vercel and more",
  description:
    "Where should an AI agent's computer run? Prices, isolation, session limits and self-hosting compared for Boat, E2B, Daytona, Novita, InstaBox, Railway, Docker and Kubernetes, with Modal, Vercel Sandbox and Northflank for reference.",
  h1: "Best sandboxes for AI agents in 2026",
  intro: [
    "An AI agent that only chats can't do much. To clean up an inbox, research a list of companies or fix a bug, it needs a computer: a browser it can sign in with, files it can keep, and a terminal to run things in. A sandbox is that computer, kept apart from yours so a mistake stays contained.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer. You can watch its screen and take over at any moment. Where that computer runs is your choice: a hosted sandbox, a container on your own server, a Kubernetes cluster, or your own Mac or PC. This page compares every option Rakazo supports, with prices as of November 2026, and the popular sandboxes it doesn't support, so you can see where they fit.",
  ],
  scene: {
    bot: "Inbox Manager",
    color: "#6A6BF5",
    where: "Computer on any sandbox",
    ask: "inbox got away from me over the weekend, sweep it?",
    reply: "on it. 41 unread since friday. archiving the noise, drafting the rest.",
    computer: {
      task: "Sweeping Gmail back to Friday.",
      screen: {
        host: "mail.google.com",
        title: "Inbox: 5 drafts parked",
        lines: ["41 threads read", "26 archived · 9 replied", "Nora's renewal held"],
      },
    },
  },
  sections: HUB_SECTIONS,
  choose: [
    {
      heading: "You want it hosted",
      text: `[Boat](/sandboxes/boat/) is what Rakazo Cloud runs its own bot computers on: full Linux VMs where every bot keeps its own Chrome logins, for a $${BOAT.minimum} monthly minimum. [E2B](/sandboxes/e2b/) is the option Rakazo's live computer tests run on, gives every computer its own microVM, and pauses idle computers instead of deleting them. [Novita](/sandboxes/novita/) pauses with memory, so a bot comes back to the same open programs, with no plan fee. [InstaBox](/sandboxes/instabox/) also pauses with memory, at low hourly rates, with a free plan for one computer. [Daytona](/sandboxes/daytona/) keeps each computer's disk, has no session cap, and suits teams already using it.`,
    },
    {
      heading: "You want the smallest bill",
      text: "If bots work an hour or two a day, a per-second provider such as [Novita](/sandboxes/novita/) or [E2B](/sandboxes/e2b/) costs a few dollars a month, and [InstaBox](/sandboxes/instabox/)'s free plan runs one computer at no charge. If they work most of the day, [Boat](/sandboxes/boat/)'s flat minimum, InstaBox's Pro plan or a [Docker](/sandboxes/docker/) server you rent is cheaper. Cheapest of all is a spare machine you already own.",
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
      heading: "You run bots for other people",
      text: "For a public or multi-user instance, keep computers off the server that runs Rakazo and behind a VM boundary: [E2B](/sandboxes/e2b/) or [Boat](/sandboxes/boat/) hosted, or [Kubernetes](/sandboxes/kubernetes/) with gVisor or Kata on your own cluster.",
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
      question: "How much does an AI agent sandbox cost?",
      answer: `Most hosted sandboxes Rakazo supports charge about ${usd(hostedHourly[0])} to ${usd(hostedHourly[1])} an hour for 2 vCPU and 4 GB while running, as of November 2026, so a computer used 4 hours a workday costs about $${Math.round(hostedWorkday[0])} to $${Math.round(hostedWorkday[1])} a month. InstaBox charges about ${rateUsd(instaboxHourly)} an hour for the ${instaboxShapeLabel} computer Rakazo uses there. Boat has a $${BOAT.minimum} monthly minimum, and InstaBox's $${INSTABOX.proFee} Pro fee comes back as usage credit, so both cover far more hours. Self-hosting costs whatever your server does.`,
    },
    {
      question: "What is the cheapest sandbox for AI agents?",
      answer:
        "A spare computer running [Docker](/sandboxes/docker/), which costs only electricity. Among the hosted options compared here, [InstaBox](/sandboxes/instabox/) and [Boat](/sandboxes/boat/) have the lowest hourly rates. InstaBox also has a free plan for one computer, and Boat and InstaBox's Pro plan are cheapest for computers that run most of the day.",
    },
    {
      question: "Is the E2B sandbox free?",
      answer: `E2B's Hobby plan has no monthly fee and a one-time $${E2B_CREDIT} credit, but sessions end after an hour. See [E2B pricing](/sandboxes/e2b/).`,
    },
    {
      question: "Does Rakazo support Modal or Vercel Sandbox?",
      answer:
        "No. Rakazo supports Boat, E2B, Daytona, Novita, InstaBox, Railway, Wuying, CreateOS, boxd, Docker, Kubernetes, Incus and your own computer. Modal and Vercel Sandbox are compared above for reference.",
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
      question: "Is Docker a real sandbox for AI agents?",
      answer:
        "It's a real boundary but not the strongest. Rakazo's containers drop every Linux capability and cap memory, CPU and processes, but they share the host's kernel. For bots you don't fully trust, pick a provider that gives each computer its own kernel as Rakazo uses it: [E2B](/sandboxes/e2b/), [InstaBox](/sandboxes/instabox/) and CreateOS (Firecracker microVMs), boxd (microVMs), [Boat](/sandboxes/boat/) and [Railway](/sandboxes/railway/) (full VMs), or [Kubernetes](/sandboxes/kubernetes/) with Kata. gVisor on Kubernetes is a middle ground. Not every hosted sandbox qualifies: Rakazo creates [Daytona](/sandboxes/daytona/) computers as Daytona's default containers, which share the host's kernel, and Novita doesn't say what it uses.",
    },
  ],
  sources: HUB_SOURCES,
} as const;

export const SANDBOXES_ARTICLE_HUB: ArticleHub = {
  label: "Sandboxes for AI agents",
  compareLabel: "Compare all sandboxes",
  href: SANDBOXES_PATH,
  moreHeading: "More sandboxes for AI agents",
  guide: { label: "Computer providers guide", href: COMPUTER_PROVIDERS_DOCS_PATH },
};

export function sandboxLink(sandbox: Sandbox): ArticleLink {
  return { name: sandbox.name, href: sandboxPath(sandbox.slug), meta: sandbox.bestFor, image: sandbox.image };
}

export function otherSandboxes(sandbox: Sandbox): ArticleLink[] {
  return SANDBOXES.filter((other) => other.slug !== sandbox.slug).map(sandboxLink);
}

/** Markdown twin of a sandbox page, for agents and `.md` requests. */
export function sandboxMarkdown(sandbox: Sandbox): string {
  return articleMarkdown(sandbox, {
    hub: SANDBOXES_ARTICLE_HUB,
    others: otherSandboxes(sandbox),
    updated: SANDBOXES_UPDATED,
  });
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
    ...SANDBOXES_HUB.sections.flatMap(sectionMarkdown),
    "## How to choose",
    "",
    ...SANDBOXES_HUB.choose.flatMap((item) => [`### ${item.heading}`, "", absolute(item.text), ""]),
    `[Computer providers guide](${SITE_URL}${COMPUTER_PROVIDERS_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...SANDBOXES_HUB.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
    "## Sources",
    "",
    ...SANDBOXES_HUB.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ].join("\n");
}
