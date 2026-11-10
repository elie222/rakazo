import {
  BOAT_RAKAZO,
  E2B_PRO_FEE,
  METHOD_NOTE,
  MONTH_HOURS,
  NOVITA_CREDIT,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  WORKDAY_HOURS,
  boatMonthly,
  count,
  hourly,
  monthly,
  perSecondUsd,
  rateUsd,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

const hour = hourly(RATES.novita);
const workday = monthly(RATES.novita, WORKDAY_HOURS);
const always = monthly(RATES.novita, MONTH_HOURS);
const creditHours = Math.round(NOVITA_CREDIT / hour / 50) * 50;
const discount = Math.round((1 - workday / monthly(RATES.e2b, WORKDAY_HOURS)) * 100);

export const novita: Sandbox = {
  slug: "novita",
  name: "Novita",
  runsOn: "Hosted Linux sandbox",
  keeps: "Files, browser logins and running programs",
  bestFor: "Bots that pick up where they left off",
  title: "Novita Agent Sandbox for AI agents: pricing, limits and computers that pause",
  description:
    "Novita Agent Sandbox pricing, limits and E2B compatibility, and how Rakazo runs AI agents' computers on it. Idle computers pause with their memory, so a bot comes back to the same open browser and programs.",
  h1: "Run your AI agents' computers on Novita",
  intro: [
    "Novita's Agent Sandbox gives AI agents their own Linux machines in the cloud, started and stopped through an API. Novita AI also sells model APIs and GPUs, and its sandbox works with the E2B SDK.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each bot gets its own computer with a desktop, a browser, a terminal and files. You can watch its screen and take over at any time. When you self-host Rakazo, Novita can be where those computers live. Its main strength is the pause: an idle computer is frozen with its memory intact, so a bot comes back to the same open tabs and running programs.",
  ],
  scene: {
    bot: "Talent Scout",
    color: "#3B82F6",
    where: "Computer on Novita",
    ask: "pick the infra applicants back up where you stopped yesterday",
    reply: "same tab is still open on applicant 34. carrying on from there.",
    computer: {
      task: "Back in Ashby where it paused.",
      screen: {
        host: "app.ashbyhq.com",
        title: "Infra applicants",
        lines: ["Resumed at applicant 34", "61 read · 9 shortlisted", "3 intros held"],
      },
    },
  },
  sections: [
    {
      heading: "What is Novita?",
      paragraphs: [
        "[Novita AI](https://novita.ai) is a cloud platform for AI developers. Alongside model APIs and GPU instances, it runs the [Agent Sandbox](https://novita.ai/sandbox): isolated Linux machines that an agent can start in seconds, run commands in, and pause when it is done. A paused sandbox keeps its disk and memory, and resumes as the same machine.",
        "Novita offers a desktop image for these sandboxes, which is what Rakazo builds on. You need a Novita account and an API key. Usage is billed by Novita, not by Rakazo.",
        "Sandboxes run in the US, in Phoenix by default. Novita describes the isolation only as system-level separation and doesn't name the technology.",
      ],
      image: true,
    },
    {
      heading: "Novita sandbox pricing",
      paragraphs: [
        `Novita bills CPU and memory by the second while a sandbox runs, with no monthly fee. Pausing stops both. Paused sandboxes, templates and snapshots count as stored data, with 60 GB free per account. New accounts can get $${NOVITA_CREDIT} of credit by answering a short setup survey, with no card needed.`,
      ],
      table: {
        caption: "Novita Agent Sandbox rates as of November 2026",
        columns: ["What", "Price or limit"],
        rows: [
          { topic: "CPU", cells: [`${perSecondUsd(RATES.novita.vcpuHour)} per vCPU-second, about ${rateUsd(RATES.novita.vcpuHour)} an hour`] },
          { topic: "Memory", cells: [`${perSecondUsd(RATES.novita.gbHour)} per GiB-second, about ${rateUsd(RATES.novita.gbHour)} an hour`] },
          { topic: "Disk while running", cells: ["20 GB per sandbox, free"] },
          { topic: "Stored data", cells: ["60 GB free per account, then $0.00009 per GB-hour"] },
          { topic: "Free credit", cells: [`$${NOVITA_CREDIT} after a setup survey`] },
          { topic: "Free tier limits", cells: ["5 sandboxes at once, 1-hour sessions, up to 2 vCPU / 4 GB"] },
          { topic: "Paid limits", cells: ["100 sandboxes at once, 24-hour sessions, up to 8 vCPU / 8 GB"] },
        ],
        note: `${PRICES_NOTE} Sources: [Novita sandbox pricing](https://docs.novita.ai/guides/sandbox-pricing) and the [sandbox overview](https://docs.novita.ai/guides/sandbox-overview).`,
      },
    },
    {
      heading: "What a Rakazo computer costs on Novita",
      paragraphs: [
        `${METHOD_NOTE} Rakazo's \`rakazo-computer\` template on Novita is exactly that size, about ${usd(hour)} an hour while it runs.`,
      ],
      table: {
        caption: "One 2 vCPU / 4 GB computer a month",
        columns: ["Provider", "4 hours a workday (88 hours)", "Around the clock (720 hours)"],
        rows: [
          { topic: "Novita", cells: [usd(workday), usd(always)] },
          {
            topic: "[E2B](/sandboxes/e2b/)",
            cells: [
              usd(monthly(RATES.e2b, WORKDAY_HOURS)),
              `${usd(monthly(RATES.e2b, MONTH_HOURS))}, or ${usd(monthly(RATES.e2b, MONTH_HOURS) + E2B_PRO_FEE)} with Pro for 24-hour sessions`,
            ],
          },
          {
            topic: "[Daytona](/sandboxes/daytona/)",
            cells: [usd(monthly(RATES.daytona, WORKDAY_HOURS)), usd(monthly(RATES.daytona, MONTH_HOURS))],
          },
          {
            topic: "[Boat](/sandboxes/boat/)",
            cells: [
              `${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))} minimum, at the ${BOAT_RAKAZO.vcpus} vCPU / ${BOAT_RAKAZO.gb} GB size self-hosted Rakazo uses`,
              usd(boatMonthly(BOAT_RAKAZO.hour, MONTH_HOURS)),
            ],
          },
        ],
        note: "Computed from each provider's rates, checked November 2026, before free credits. Your model provider bills separately.",
      },
      bullets: [
        `The $${NOVITA_CREDIT} credit covers about ${count(creditHours)} hours of this computer.`,
        "A paused computer keeps its memory as stored data. A few paused computers fit within the 60 GB free allowance; beyond it, each extra 10 GB costs about $0.65 a month.",
        "Around-the-clock use needs the paid tier, where a session ends after 24 hours. Rakazo pauses a computer after two hours of uptime, but waits while a run is executing, someone controls the screen or a coding agent is working. A computer kept busy that long can reach Novita's 24-hour limit, which cuts the work off until the next resume.",
      ],
    },
    {
      heading: "What a bot can do on a Novita computer",
      paragraphs: [
        "Rakazo turns each Novita sandbox into a full bot computer. A bot works there the same way it does on any other Linux provider, and you see it in the computer panel next to the chat.",
      ],
      bullets: [
        "Use a Linux desktop and browser, with each bot on its own screen when several bots share one computer.",
        "Run shell commands, which you or the bot can cancel, and read and write files.",
        "You can open a terminal on the computer yourself, watch the screen live, and take over when a bot asks for help with a login or a captcha.",
        "When the computer sits idle or is stopped, Rakazo pauses it instead of deleting it. Files, browser profiles and the memory of running programs are kept, and the next use resumes the same computer.",
      ],
    },
    {
      heading: "When to choose Novita",
      paragraphs: [
        "Choose Novita when bots run long, multi-step work in a browser and you want them to come back to exactly where they were, not to a fresh desktop rebuilt from saved files. It also fits if you already use Novita for models or GPUs and want one fewer account.",
        "[E2B](/sandboxes/e2b/) pauses idle computers in a similar way and is what Rakazo's own live computer tests run on. [Boat](/sandboxes/boat/) is what Rakazo Cloud uses, with a separate Chrome profile for each bot, but it keeps the disk, not running programs. [Railway](/sandboxes/railway/) rebuilds a computer from saved files after every stop. If you don't want a cloud account at all, [Docker](/sandboxes/docker/) runs computers on your own server. The [sandbox comparison](/sandboxes/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "It needs a one-time template build in your Novita account. Rakazo does not fall back to Novita's larger stock desktop.",
        "You can't pick a region from Rakazo, and Novita's standard regions are in the US.",
        "On the free tier a session lasts at most an hour and five sandboxes can run at once.",
        "Paused computers still use storage, which Novita bills and retains on its own terms.",
        "If Rakazo can't confirm that a command stopped, it pauses the computer and sets it aside. It stays paused until you choose Recover or Reset, so it is never resumed silently with a stuck command inside.",
        "Novita computers are for self-hosted Rakazo. Rakazo Cloud runs its computers on Boat.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "This is done once by the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/) deployment. Everyone else on that deployment then gets Novita computers without doing anything.",
      ],
      steps: [
        "Create an API key in your Novita account.",
        "Build the computer template in that same account: `NOVITA_API_KEY=<your-key> pnpm sandbox:novita-template`. It creates a template called `rakazo-computer` with 2 vCPU and 4 GB of memory, based on Novita's desktop image.",
        "Set `SANDBOX_PROVIDER=novita` and `NOVITA_API_KEY` on both the API and the worker, then restart them. Or, as an admin, open Settings → Computer and choose Novita under New computers run on.",
        "Open a bot's computer to check that it starts and shows a desktop.",
      ],
    },
    {
      heading: "Using your own template",
      paragraphs: [
        "To use a different desktop template, set `SANDBOX_TEMPLATE` to its name both when you build it and on the API and worker. Rebuild after the template definition changes. Computers that already exist keep the template and resources they started with. The [computer providers guide](/docs/self-host-sandbox-providers/) has the full details.",
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/novita.webp",
    avif: "/graphics/sandboxes/novita.avif",
    width: 1280,
    height: 800,
    alt: "The Novita Agent Sandbox page, headed Runtime for AI agents to execute real-world tasks.",
    caption: "Novita homepage, November 4, 2026.",
  },
  faq: [
    {
      question: "Is Novita cheaper than E2B?",
      answer: `Per second, yes: about ${discount}% less for the same 2 vCPU / 4 GB computer, with no monthly fee for 24-hour sessions. Both pause with memory. [E2B](/sandboxes/e2b/) uses Firecracker microVMs, is open source and has more regions.`,
    },
    {
      question: "Is Novita's sandbox compatible with E2B?",
      answer:
        "Novita's sandbox works with the E2B SDK. In Rakazo they are separate providers with their own settings, so you choose [Novita](/sandboxes/novita/) or [E2B](/sandboxes/e2b/) with `SANDBOX_PROVIDER`.",
    },
  ],
  sources: [
    { label: "Novita Agent Sandbox", href: "https://novita.ai/sandbox" },
    { label: "Novita sandbox overview", href: "https://docs.novita.ai/guides/sandbox-overview" },
    PRICING.novita,
    PRICING.e2b,
    PRICING.daytona,
    PRICING.boat,
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
