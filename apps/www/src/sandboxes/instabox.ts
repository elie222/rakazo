import {
  BOAT_RAKAZO,
  E2B_PRO_FEE,
  INSTABOX,
  METHOD_NOTE,
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  WORKDAY_HOURS,
  boatMonthly,
  hourly,
  instaboxProMonthly,
  monthly,
  rateUsd,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

const shape = `${INSTABOX.size.vcpus} vCPU / ${INSTABOX.size.gb} GB`;
const hour = hourly(RATES.instabox, INSTABOX.size);
const workdayUsage = monthly(RATES.instabox, WORKDAY_HOURS, INSTABOX.size);
const creditHours = Math.round(INSTABOX.proFee / hour / 10) * 10;
const atSize = (rate: (typeof RATES)[keyof typeof RATES], hours: number) => usd(monthly(rate, hours, INSTABOX.size));

export const instabox: Sandbox = {
  slug: "instabox",
  name: "InstaBox",
  runsOn: "Hosted Debian microVM",
  keeps: "Files, browser logins and running programs",
  bestFor: "Low-cost computers that pause with memory",
  title: "InstaBox for AI agents: pricing, limits and cloud computers that pause",
  description: `InstaBox pricing, plans and limits, and how Rakazo runs AI agents' computers on its Firecracker microVMs. A free plan for one computer, or $${INSTABOX.proFee} a month plus usage, and every computer pauses with its memory.`,
  h1: "Run your AI agents' computers on InstaBox",
  intro: [
    "[InstaBox](https://instabox.sh) gives each AI agent a Linux machine of its own in the cloud. Each machine is a Firecracker microVM running Debian, which you start, pause and delete through an API, a command-line tool or a TypeScript SDK.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each bot gets its own computer with a desktop, a browser, a terminal and files. You can watch its screen and take over at any time. When you self-host Rakazo, InstaBox can be where those computers live. Its strengths are price and the pause: it bills by the second at low hourly rates, and a stopped computer keeps its memory, so a bot comes back to the same open tabs and running programs.",
  ],
  scene: {
    bot: "Account Manager",
    color: "#9B5CF6",
    where: "Computer on InstaBox",
    ask: "check usage for every account renewing in december and flag the ones that dropped",
    reply: "on it. the billing dashboard is still open from yesterday. flagging drops as i go.",
    computer: {
      task: "Checking December renewals.",
      screen: {
        host: "dashboard.stripe.com",
        title: "Renewals: December",
        lines: ["48 accounts checked", "7 usage drops flagged", "A note saved for each"],
      },
    },
  },
  sections: [
    {
      heading: "What is InstaBox?",
      paragraphs: [
        "[InstaBox](https://instabox.sh) runs cloud computers for AI agents. Each machine is a Firecracker microVM, a lightweight virtual machine with its own kernel, running Debian 13 with a 20 GiB disk that is kept between sessions. Machines start from templates, can be paused with their memory and resumed later, and are billed by the second while they run.",
        "Its default template, `agent-browser`, comes with a desktop, Chromium, Docker and common programming languages, and it is what Rakazo builds on. You need an InstaBox account and an API key. Usage is billed by InstaBox, not by Rakazo.",
        "InstaBox's API has no region setting: it decides where each machine runs.",
      ],
      image: true,
    },
    {
      heading: "InstaBox pricing",
      paragraphs: [
        `InstaBox bills CPU and memory by the second while a machine runs. A paused machine costs only its disk, and its saved memory is free. Paid plans have a monthly fee that comes back as the same amount of usage credit. The free plan runs one machine and is never billed.`,
      ],
      table: {
        caption: "InstaBox plans as of November 2026",
        columns: ["Plan", "Monthly fee", "Machines", "Sizes"],
        rows: [
          { topic: "Free", cells: ["$0", "1, paused ones included", "4 vCPU / 8 GiB only"] },
          {
            topic: "Pro",
            cells: [`$${INSTABOX.proFee}, returned as usage credit`, "100 running, 500 in all", "Up to 8 vCPU / 16 GiB"],
          },
          { topic: "Builder", cells: ["$100, returned as usage credit", "200 running, 1,000 in all", "Up to 16 vCPU / 32 GiB"] },
          { topic: "Team", cells: ["$500, returned as usage credit", "500 running, no cap in all", "Up to 32 vCPU / 64 GiB"] },
          { topic: "Enterprise", cells: ["Custom", "No cap", "Up to 32 vCPU / 64 GiB"] },
        ],
        note: `${PRICES_NOTE} Sources: [InstaBox pricing](https://instabox.sh/pricing) and [limits](https://instabox.sh/docs/account/limits).`,
      },
      bullets: [
        `Usage costs $${RATES.instabox.vcpuHour} per vCPU-hour and $${RATES.instabox.gbHour} per GiB-hour of memory, metered by the second. The default ${INSTABOX.size.vcpus} vCPU / ${INSTABOX.size.gb} GiB machine costs about ${rateUsd(hour)} an hour.`,
        "Disk is free on the free plan. Paid plans include disk across all their machines, 200 GiB on Pro up to 5 TiB on Team, then charge $0.08 per GiB a month.",
        "Each plan includes outgoing traffic, 100 GiB a month on the free plan and 1 TiB on Pro, then $0.02 per GiB. Incoming traffic is free.",
        "On the free plan, a machine pauses after 30 idle minutes and runs at most 8 hours at a time, both fixed, and its hours are capped each month.",
      ],
    },
    {
      heading: "What a Rakazo computer costs on InstaBox",
      paragraphs: [
        `${METHOD_NOTE} Rakazo's InstaBox computers are bigger: Rakazo doesn't pick a size, so every computer gets the plan's default, ${shape}, about ${rateUsd(hour)} an hour. The table compares that size. On Pro, the $${INSTABOX.proFee} fee comes back as usage credit, enough for about ${creditHours} hours of it a month, shared by every computer on the account.`,
      ],
      table: {
        caption: `One ${shape} computer a month`,
        columns: ["Provider", "4 hours a workday (88 hours)", "Around the clock (720 hours)"],
        rows: [
          {
            topic: "InstaBox, free plan",
            cells: ["$0, if the plan's monthly hours cover it", "Not possible: each run pauses after 8 hours"],
          },
          {
            topic: "InstaBox, Pro",
            cells: [
              `${usd(instaboxProMonthly(WORKDAY_HOURS))}, the fee (${usd(workdayUsage)} of usage)`,
              usd(instaboxProMonthly(MONTH_HOURS)),
            ],
          },
          {
            topic: "[Boat](/sandboxes/boat/)",
            cells: [
              `${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))}, the minimum`,
              usd(boatMonthly(BOAT_RAKAZO.hour, MONTH_HOURS)),
            ],
          },
          { topic: "[Novita](/sandboxes/novita/)", cells: [atSize(RATES.novita, WORKDAY_HOURS), atSize(RATES.novita, MONTH_HOURS)] },
          {
            topic: "[E2B](/sandboxes/e2b/)",
            cells: [
              atSize(RATES.e2b, WORKDAY_HOURS),
              `${atSize(RATES.e2b, MONTH_HOURS)}, or ${usd(monthly(RATES.e2b, MONTH_HOURS, INSTABOX.size) + E2B_PRO_FEE)} with Pro for 24-hour sessions`,
            ],
          },
          { topic: "[Daytona](/sandboxes/daytona/)", cells: [atSize(RATES.daytona, WORKDAY_HOURS), atSize(RATES.daytona, MONTH_HOURS)] },
        ],
        note: "Computed from each provider's rates, checked November 2026, before free credits. Your model provider bills separately.",
      },
      bullets: [
        "A paused computer costs only its disk. Each computer's 20 GiB disk counts toward the disk a paid plan includes, so ten computers fit in Pro's 200 GiB.",
        "Around-the-clock use needs a paid plan. Rakazo stops a computer after two hours of uptime, but waits while a run is executing, someone controls the screen or a coding agent is working. On the free plan, a computer kept busy that long can reach InstaBox's 8-hour limit, which pauses it, and it can't be woken until a cooldown of at least 5 minutes ends.",
      ],
    },
    {
      heading: "What a bot can do on an InstaBox computer",
      paragraphs: [
        "Rakazo turns each InstaBox machine into a full bot computer. A bot works there the same way it does on any other Linux provider, and you see it in the computer panel next to the chat.",
      ],
      bullets: [
        "Use a Linux desktop and Chromium, with each bot on its own screen when several bots share one computer.",
        "Run shell commands, which you or the bot can cancel, and read and write files.",
        "You can open a terminal on the computer yourself, watch the screen live, and take over when a bot asks for help with a login or a captcha.",
        "When the computer sits idle or is stopped, Rakazo pauses it instead of deleting it. Files, browser logins and the memory of running programs are kept, and the next use resumes the same computer.",
      ],
    },
    {
      heading: "When to choose InstaBox",
      paragraphs: [
        "Choose InstaBox when you want hosted computers that pause with their memory at a low hourly price, or want to try a bot computer on a free plan before you pay anything. Each computer is a microVM with its own kernel, and the `agent-browser` template already has a desktop and Chromium, so there is no template to build first.",
        "[Novita](/sandboxes/novita/) and [E2B](/sandboxes/e2b/) also pause with memory and bill by the second, at higher rates. [Boat](/sandboxes/boat/) is what Rakazo Cloud uses, with a separate Chrome profile for each bot, but it keeps the disk, not running programs. If you don't want a cloud account at all, [Docker](/sandboxes/docker/) runs computers on your own server. The [sandbox comparison](/sandboxes/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "The free plan allows one machine, paused ones included, which fits one person's bots in one space. More computers need a paid plan.",
        `You can't choose a size or a region from Rakazo. Every computer gets the plan's default ${shape}.`,
        "InstaBox also pauses a computer after 30 idle minutes on its own. Rakazo's default idle stop, after 10 minutes, normally comes first.",
        "Rakazo creates every InstaBox computer without your account's vault, so secrets saved on that InstaBox account never reach a bot's computer. Anything a bot needs has to come through Rakazo.",
        "The desktop is served on the computer's public HTTPS address, and every screen and terminal needs its own token.",
        "All the computers on one API key share that account's limits on requests at once, for commands, files, screens and terminals. Many busy computers at the same moment can slow each other down.",
        "InstaBox computers are for self-hosted Rakazo. Rakazo Cloud runs its computers on Boat.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "This is done once by the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/) deployment. Everyone else on that deployment then gets InstaBox computers without doing anything.",
      ],
      steps: [
        "Create an API key on the API Keys page of the InstaBox dashboard, or with `instabox keys create --name rakazo`. Computers are created in the key's workspace, which pays for them.",
        "Set `SANDBOX_PROVIDER=instabox` and `INSTABOX_API_KEY` on both the API and the worker, then restart them. Or, as an admin, open Settings → Computer and choose InstaBox under New computers run on.",
        "Open a bot's computer to check that it starts and shows a desktop. A new computer is created in about two seconds, and the first start installs the rest of Rakazo's desktop tools in a few more.",
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/instabox.webp",
    avif: "/graphics/sandboxes/instabox.avif",
    width: 1280,
    height: 800,
    alt: "The InstaBox homepage, headed Cloud Computers for AI Agents.",
    caption: "InstaBox homepage, November 10, 2026.",
  },
  faq: [
    {
      question: "Is InstaBox cheaper than E2B?",
      answer: `Per hour, yes. Rakazo's InstaBox computer has ${shape} and costs about ${rateUsd(hour)} an hour, while its E2B computer has 2 vCPU / 4 GB and costs about ${usd(hourly(RATES.e2b))}. More than one InstaBox computer needs the $${INSTABOX.proFee} Pro plan, whose fee comes back as usage credit. Both use Firecracker microVMs and pause with memory. [E2B](/sandboxes/e2b/) is open source.`,
    },
    {
      question: "Does InstaBox's free plan work with Rakazo?",
      answer:
        "Yes, for one computer. The free plan can create from `agent-browser`, the template Rakazo uses, at the default size. A second computer, such as one for a bot with a computer of its own, needs a paid plan.",
    },
  ],
  sources: [
    { label: "InstaBox", href: "https://instabox.sh" },
    PRICING.instabox,
    { label: "InstaBox docs, pricing", href: "https://instabox.sh/docs/account/pricing" },
    { label: "InstaBox docs, limits", href: "https://instabox.sh/docs/account/limits" },
    { label: "InstaBox docs, auto-pause and max-run", href: "https://instabox.sh/docs/machines/auto-pause" },
    { label: "InstaBox docs, errors", href: "https://instabox.sh/docs/reference/errors" },
    PRICING.boat,
    PRICING.novita,
    PRICING.e2b,
    PRICING.daytona,
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
