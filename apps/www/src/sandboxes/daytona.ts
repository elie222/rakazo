import { HOSTED_SANDBOXES_TABLE } from "./compare";
import {
  DAYTONA_CREDIT,
  E2B_PRO_FEE,
  METHOD_NOTE,
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  WORKDAY_HOURS,
  count,
  hourly,
  homepage,
  monthly,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

const DEFAULT_SIZE = { vcpus: 1, gb: 1 };
const hour = hourly(RATES.daytona);
const workday = monthly(RATES.daytona, WORKDAY_HOURS);
const creditHours = Math.round(DAYTONA_CREDIT / hour / 100) * 100;
const modalPremium = Math.round((monthly(RATES.modal, WORKDAY_HOURS) / workday - 1) * 100);

export const daytona: Sandbox = {
  slug: "daytona",
  name: "Daytona",
  runsOn: "Hosted Linux sandbox",
  keeps: "Its disk",
  bestFor: "Teams already on Daytona",
  title: "Daytona sandbox pricing, limits and alternatives in 2026: Daytona vs E2B for AI agents",
  description:
    `Daytona sandbox pricing explained: per-second rates, the $${DAYTONA_CREDIT} credit, usage tiers and what an AI agent's desktop costs a month. Daytona vs E2B, Modal and Vercel, its closed-source move, and how Rakazo runs bots on Daytona.`,
  h1: "Daytona sandboxes for AI agents: pricing, limits and alternatives",
  intro: [
    "[Daytona](https://www.daytona.io) is a hosted service for running AI-generated code in sandboxes. Each sandbox is an isolated Linux machine with its own disk, which can be stopped, archived and started again later.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. If your team already uses Daytona, a self-hosted Rakazo can put those computers there. Daytona supplies the sandbox. Rakazo installs the desktop, gives each bot its own screen, saves its work, and decides when the sandbox stops.",
    "This page covers what Daytona costs as of November 2026, the limits that catch people out, what its move to closed source means, and how it compares with E2B, Modal, Vercel Sandbox and the rest.",
  ],
  scene: {
    bot: "Talent Scout",
    color: "#3B82F6",
    where: "Computer on Daytona",
    ask: "read the infra applicants and shortlist anyone who has run their own cluster",
    reply: "on it. reading every profile and repo. intros held for you.",
    computer: {
      task: "Reading applicants in Ashby.",
      screen: {
        host: "app.ashbyhq.com",
        title: "Infra applicants",
        lines: ["61 read", "9 shortlisted: ran their own cluster", "3 intros held"],
      },
    },
  },
  sections: [
    {
      heading: "What is Daytona?",
      paragraphs: [
        "[Daytona](https://www.daytona.io) gives developers and AI agents sandboxes they can create through an API. Sandboxes start from snapshots, run in shared US or EU regions or in a region of your own, and keep their disk when they stop. A sandbox that has been archived is moved to cheaper storage and copied back when it wakes. Daytona claims sandbox creation in under 90 ms.",
        "By default a Daytona sandbox is a container that shares its host's kernel. Linux VM, Windows and macOS sandboxes are also available, and only VMs can pause with their memory. Daytona reports SOC 2 Type II.",
      ],
      image: true,
    },
    {
      heading: "Daytona pricing",
      paragraphs: [
        `Daytona has no plans or monthly fee. You pay per second for the CPU and memory a sandbox has while it runs, and per hour for disk beyond the first 5 GiB. New accounts get $${DAYTONA_CREDIT} of free compute with no card needed.`,
      ],
      table: {
        caption: "Daytona rates as of November 2026",
        columns: ["What", "Price"],
        rows: [
          { topic: "CPU", cells: [`$${RATES.daytona.vcpuHour} per vCPU-hour, billed per second`] },
          { topic: "Memory", cells: [`$${RATES.daytona.gbHour} per GiB-hour`] },
          { topic: "Disk", cells: ["First 5 GiB free, then $0.000108 per GiB-hour"] },
          { topic: "Windows sandboxes", cells: ["$0.0858 per vCPU-hour"] },
          { topic: "GPUs", cells: ["From $0.57 an hour (RTX 4090) to $4.08 (B300), preemptible"] },
          { topic: "Free credit", cells: [`$${DAYTONA_CREDIT}, and up to $50,000 for startups`] },
          { topic: "Enterprise", cells: ["Custom, with SSO, audit logs and your own cloud"] },
        ],
        note: `${PRICES_NOTE} Source: [Daytona pricing](https://www.daytona.io/pricing).`,
      },
      bullets: [
        "What you pay depends on the sandbox's state. Running bills CPU, memory and disk. Stopped and paused bill disk only. Archived bills nothing. Snapshots keep billing for storage even after the sandbox is deleted.",
        "Your account's tier caps the total CPU, memory and disk of everything running at once. Tier 1, with a verified email, allows 10 vCPU and 10 GiB in total. A $25 top-up with a card moves you to 100 vCPU and 200 GiB, and larger top-ups go further.",
        "A single sandbox can have at most 4 vCPU, 8 GiB of memory and 10 GiB of disk.",
      ],
    },
    {
      heading: "What a Rakazo computer costs on Daytona",
      paragraphs: [
        `${METHOD_NOTE} Rakazo doesn't set a size on Daytona, so a computer gets the size of the snapshot it starts from. Daytona's default is 1 vCPU and 1 GiB, which is tight for a desktop and Chromium; for real browser work, point \`DAYTONA_SNAPSHOT\` at a 2 vCPU / 4 GiB snapshot, such as Daytona's \`daytona-medium\` size.`,
      ],
      table: {
        caption: "One Rakazo computer on Daytona",
        columns: ["How long it runs", "1 vCPU / 1 GiB (default)", "2 vCPU / 4 GiB"],
        rows: [
          { topic: "One hour", cells: [usd(hourly(RATES.daytona, DEFAULT_SIZE)), usd(hour)] },
          {
            topic: `4 hours a workday, ${WORKDAY_HOURS} hours a month`,
            cells: [usd(monthly(RATES.daytona, WORKDAY_HOURS, DEFAULT_SIZE)), usd(workday)],
          },
          {
            topic: `Around the clock, ${MONTH_HOURS} hours`,
            cells: [usd(monthly(RATES.daytona, MONTH_HOURS, DEFAULT_SIZE)), usd(monthly(RATES.daytona, MONTH_HOURS))],
          },
        ],
        note: `Computed from Daytona's rates, checked November 2026, before the $${DAYTONA_CREDIT} credit. Disk under 5 GiB is free; an 8 GiB disk adds about $0.24 a month. A stopped computer bills only for disk. Your model provider bills separately.`,
      },
      bullets: [
        "Tier 1's 10 GiB limit fits only two 2 vCPU / 4 GiB computers at once. Top up once to lift it.",
        "On Rakazo Cloud you don't pay Daytona at all. Cloud computers run on [Boat](/sandboxes/boat/) and are included in the [plan](/pricing/).",
      ],
    },
    {
      heading: "What your bots can do on a Daytona computer",
      paragraphs: [
        "On Daytona, each Rakazo bot works on a real Linux desktop. You see its screen in the chat and can take over the mouse and keyboard at any time.",
      ],
      bullets: [
        "Browse the web in Chromium, with its own screen and browser profile. Signed-in sessions stay between runs.",
        "Run shell commands, read and write files, and open a terminal you can type in yourself.",
        "Share one computer. By default, one person's bots in a space share that person's team computer, each on its own screen. A bot can have a computer of its own instead.",
        "Keep their files. A stopped computer keeps its disk, and Rakazo also keeps its own copy of each bot's workspace, so a lost sandbox is replaced from the saved work.",
      ],
    },
    {
      heading: "Daytona vs E2B and other alternatives",
      paragraphs: [
        "Daytona and E2B charge exactly the same per second, so price alone won't decide it. The differences are isolation, session limits, what survives a stop and who controls the code.",
      ],
      table: HOSTED_SANDBOXES_TABLE,
      bullets: [
        `**Daytona vs E2B.** Daytona has no monthly fee and no session cap, which suits long-running agents. [E2B](/sandboxes/e2b/) needs its $${E2B_PRO_FEE} Pro plan for sessions over an hour, but every sandbox is a Firecracker microVM with its own kernel, it pauses with memory, and it is open source. In Rakazo, E2B starts from a ready desktop template and resumes in seconds; Daytona installs the desktop on first start.`,
        `**Daytona vs Modal.** Modal runs sandboxes on gVisor, costs about ${modalPremium}% more for this computer, and has GPUs and many regions. Rakazo doesn't support Modal.`,
        "**Daytona vs Vercel Sandbox.** Vercel uses Firecracker microVMs and bills CPU only while it is busy, but caps sessions at 24 hours and keeps only the filesystem. Rakazo doesn't support Vercel Sandbox.",
        "**If you left because of the closed source.** E2B is the main open source hosted option. Northflank runs sandboxes in your own cloud. To keep everything on your own machines, Rakazo runs computers in [Docker](/sandboxes/docker/) or on [Kubernetes](/sandboxes/kubernetes/).",
      ],
    },
    {
      heading: "Is Daytona open source?",
      paragraphs: [
        "Not anymore. Daytona announced in June 2026 that it was going closed source, citing security. Its [GitHub repository](https://github.com/daytonaio/daytona) is archived, and the README says core development moved to a private codebase. The last public release, v0.190.0, remains under the AGPL-3.0 license, but it gets no updates.",
        "That matters if you picked Daytona to self-host. Enterprise customers can still run Daytona in their own cloud, but the control plane is Daytona's. For a fully self-hosted setup with Rakazo, use [Docker](/sandboxes/docker/) or [Kubernetes](/sandboxes/kubernetes/).",
      ],
    },
    {
      heading: "When to choose Daytona",
      paragraphs: [
        "Choose Daytona when your team already has a Daytona account, billing or targets you want to reuse, or when you want hosted sandboxes with no monthly fee and no session cap.",
        "If you are picking a hosted provider from scratch, [E2B](/sandboxes/e2b/) starts from a ready desktop template and pauses idle computers, and [Boat](/sandboxes/boat/) is what Rakazo Cloud runs on. [Novita](/sandboxes/novita/) keeps open programs in memory when it pauses. To avoid a cloud account, use [Docker](/sandboxes/docker/) or [Kubernetes](/sandboxes/kubernetes/). The [sandbox comparison](/sandboxes/) has them all side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "The first start of a new computer installs the desktop, so it is slower than later starts.",
        "A computer stopped for 7 days is archived by Daytona. Waking it copies its disk back first and can take up to 10 minutes.",
        "A bot sees a command's output when the command finishes, not while it runs.",
        "Rakazo runs Linux computers only on Daytona, without volumes, and the only location choice is `DAYTONA_TARGET`.",
        "Default sandboxes are containers that share their host's kernel, a weaker boundary than a microVM such as E2B's.",
        "Like other hosted providers that bill while running, a computer is stopped after two hours of continuous uptime by default unless a bot is still working on it or you are in control.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/). Rakazo Cloud users don't need a Daytona account.",
      ],
      steps: [
        "Create an API key in your Daytona account.",
        "Either set `SANDBOX_PROVIDER=daytona` and `DAYTONA_API_KEY` on the Rakazo API and worker, or sign in as an admin and choose Daytona under Settings → Computer, then paste the key.",
        "Optionally set `DAYTONA_API_URL` for a different Daytona endpoint and `DAYTONA_TARGET` for where sandboxes run. Both are also in Settings → Computer.",
        "Optionally set `DAYTONA_SNAPSHOT` in the environment to start new computers from a Daytona snapshot of your own, for example one with 2 vCPU and 4 GiB. Leave it unset to use Daytona's default.",
        "Open a bot's computer in Rakazo and wait for the first start to install the desktop.",
      ],
    },
  ],
  image: homepage("daytona", "Daytona", "The Daytona homepage, headed Run AI code."),
  faq: [
    {
      question: "Is Daytona free?",
      answer: `New accounts get $${DAYTONA_CREDIT} of free compute with no card needed, about ${count(creditHours)} hours of a 2 vCPU / 4 GiB sandbox. After that you pay for usage, with no monthly fee.`,
    },
    {
      question: "Does Daytona delete idle sandboxes?",
      answer:
        "Not the ones Rakazo creates. Rakazo turns off Daytona's auto-stop and auto-delete, and its own idle timer stops the computer, which keeps its disk. Daytona archives a computer that stays stopped for a week; it wakes more slowly but keeps its files.",
    },
  ],
  sources: [
    { label: "Daytona", href: "https://www.daytona.io" },
    PRICING.daytona,
    { label: "Daytona, sandboxes", href: "https://www.daytona.io/docs/en/sandboxes" },
    { label: "Daytona, limits", href: "https://www.daytona.io/docs/en/limits" },
    { label: "Daytona, billing", href: "https://www.daytona.io/docs/en/billing/" },
    {
      label: "Daytona is going closed source",
      href: "https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source",
    },
    { label: "Daytona on GitHub (archived)", href: "https://github.com/daytonaio/daytona" },
    PRICING.e2b,
    PRICING.modal,
    PRICING.vercel,
    PRICING.northflank,
    PRICING.blaxel,
    PRICING.novita,
    PRICING.boat,
    PRICING.createos,
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
