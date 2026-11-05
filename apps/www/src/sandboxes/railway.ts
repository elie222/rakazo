import { GITHUB_URL } from "../site";
import {
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RAILWAY_ESTIMATE,
  RUNTIME_DOC,
  WORKDAY_HOURS,
  aboutUsd,
  railwayAppMonthly,
  railwayComputerMonthly,
} from "./shared";
import type { Sandbox } from "./types";

const { computer, app } = RAILWAY_ESTIMATE;
const computerWorkday = railwayComputerMonthly(WORKDAY_HOURS);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const RAILWAY_TEMPLATE_DOC = `${GITHUB_URL}/blob/main/infra/railway/README.md`;

export const railway: Sandbox = {
  slug: "railway",
  name: "Railway",
  runsOn: "Your Railway account",
  keeps: "The workspace Rakazo saved",
  bestFor: "Running everything in one Railway account",
  title: "Railway sandboxes for AI agents: pricing, limits and hosting Rakazo in one account",
  description:
    "Deploy Rakazo on Railway from one template: the app, Postgres and your AI agents' sandbox computers in one account. Railway's usage pricing for sandboxes, a worked monthly cost, and the limits per plan.",
  h1: "Run Rakazo and your agents' computers on Railway",
  intro: [
    "Railway is a cloud platform for deploying apps and databases without managing servers. It also runs sandboxes: short-lived Linux machines that a program can create through Railway's API.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each bot gets its own computer with a desktop, a browser and files. You can watch its screen and take over at any time. On Railway, one template runs the Rakazo app, its Postgres database and those bot computers, all in your own Railway account. You don't need a Docker host or a separate sandbox provider.",
  ],
  scene: {
    bot: "Bug Triage",
    color: "#D9508A",
    where: "Computer on Railway",
    ask: "triage what came in over the weekend",
    reply: "on it. reproducing each report on my computer before i touch the issues.",
    computer: {
      task: "Reproducing reports in Sentry.",
      screen: {
        host: "sentry.io",
        title: "Auth loop: P1",
        lines: ["6 new reports", "4 reproduced", "Stale session token"],
      },
    },
  },
  sections: [
    {
      heading: "What is Railway?",
      paragraphs: [
        "[Railway](https://railway.com) deploys services from a repository or image and gives them HTTPS domains, volumes and managed databases. Usage is billed to your Railway workspace. Its [sandboxes](https://docs.railway.com/sandboxes) are separate machines created on demand, which Rakazo uses as bot computers.",
        "Because the app and the computers live in the same account, you manage one set of credentials and one bill for hosting. Your model provider is still billed separately.",
        "Each sandbox is its own virtual machine. New sandboxes run in US West unless a region is chosen.",
      ],
      image: true,
    },
    {
      heading: "Railway pricing",
      paragraphs: [
        "Railway charges a small plan fee that counts toward usage, then bills per second. Sandboxes are billed at virtual machine rates for the CPU they actually use and the memory they actually hold, not for their size, so a mostly idle desktop costs much less than its ceiling. The Rakazo app and its database run as ordinary services at the cheaper container rates.",
      ],
      table: {
        caption: "Railway plans and rates as of November 2026",
        columns: ["Plan", "Trial and Free", "Hobby", "Pro"],
        rows: [
          { topic: "Plan fee", cells: ["$0. Trial gives $5 of credit, Free $1 a month", "$5 a month, including $5 of usage", "$20 a month per workspace, including $20 of usage"] },
          { topic: "Largest sandbox", cells: ["2 vCPU / 2 GB", "8 vCPU / 8 GB", "32 vCPU / 32 GB"] },
          { topic: "Sandbox idle timeout", cells: ["1 to 5 minutes, always on", "1 to 120 minutes, or off", "1 to 120 minutes, or off"] },
          { topic: "Sandboxes running at once", cells: ["10", "50", "100"] },
          { topic: "Sandbox CPU and memory", cells: ["$50 per vCPU-month used, $50 per GB-month held", "Same", "Same"] },
          { topic: "App and database", cells: ["$20 per vCPU-month, $10 per GB-month", "Same", "Same"] },
          { topic: "Volumes and egress", cells: ["$0.15 per GB-month, $0.05 per GB out", "Same", "Same"] },
        ],
        note: `${PRICES_NOTE} Sources: [Railway pricing](https://railway.com/pricing) and [Railway sandboxes](https://docs.railway.com/sandboxes).`,
      },
    },
    {
      heading: "What Rakazo on Railway costs a month",
      paragraphs: [
        `Railway bills what a computer actually uses rather than its size, so this estimate departs from [the method on the comparison page](/sandboxes/#pricing). It assumes the Hobby plan and one bot computer running 4 hours a workday, ${WORKDAY_HOURS} hours a month, with a desktop and Chromium using about ${computer.vcpus} vCPU and ${computer.gb} GB of memory on average. The Rakazo service and Postgres run all month. Actual use varies with what bots do.`,
      ],
      table: {
        caption: "Estimated monthly bill on Railway Hobby",
        columns: ["Part", "Assumption", "Cost"],
        rows: [
          { topic: "Bot computer", cells: [`${computer.vcpus} vCPU and ${computer.gb} GB, ${WORKDAY_HOURS} hours`, capitalize(aboutUsd(computerWorkday))] },
          { topic: "Rakazo app", cells: [`About ${app.gb} GB and ${app.vcpus} vCPU, all month`, capitalize(aboutUsd(railwayAppMonthly - RAILWAY_ESTIMATE.databaseAndVolumes))] },
          { topic: "Postgres and volumes", cells: ["A small database and a few GB of files", capitalize(aboutUsd(RAILWAY_ESTIMATE.databaseAndVolumes))] },
          { topic: "Total", cells: ["The $5 plan fee counts toward this", capitalize(aboutUsd(computerWorkday + railwayAppMonthly))] },
        ],
        note: `Estimated from Railway's rates, checked November 2026. A computer left running around the clock at the same load would cost ${aboutUsd(railwayComputerMonthly(MONTH_HOURS))} on its own. Your model provider bills separately.`,
      },
      bullets: [
        "Memory dominates: Railway counts the operating system and file cache as memory in use, so a browser with many tabs costs more than its CPU suggests.",
        "Rakazo stops idle computers, and the template allows each user up to three, which keeps the bill bounded.",
        "On Rakazo Cloud you don't need Railway at all; computers are included in the [plan](/pricing/).",
      ],
    },
    {
      heading: "What a bot can do on a Railway computer",
      paragraphs: [
        "Each Railway sandbox becomes a Linux bot computer. You see it in the computer panel next to the chat, and you can step in when a bot asks for help.",
      ],
      bullets: [
        "Use a Linux desktop and browser, with each bot on its own screen when several bots share one computer.",
        "Run shell commands and read and write files.",
        "Watch the screen live and take over, for example to finish a login.",
        "Keep its workspace between sessions. Rakazo saves the workspace before a computer stops and restores it on the next start.",
      ],
    },
    {
      heading: "When to choose Railway",
      paragraphs: [
        "Choose Railway when you want a personal Rakazo with nothing to run yourself and only one account to manage. It suits bots that browse, research and edit files, where a restart from saved files is fine.",
        "If bots need to come back to the same open programs, [Novita](/sandboxes/novita/) and [E2B](/sandboxes/e2b/) pause computers with their memory instead. [Boat](/sandboxes/boat/), which Rakazo Cloud uses, keeps each computer's disk and a Chrome profile per bot. If you'd rather use a server you already have, [Docker](/sandboxes/docker/) is the default when you self-host. The [sandbox comparison](/sandboxes/) covers every option.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "No pause. Stopping deletes the sandbox, and the next start restores the bot's saved workspace. Open programs and anything outside the workspace are lost.",
        "There is no terminal you can open yourself, and a command's output arrives when it finishes rather than while it runs.",
        "The desktop installs the first time a computer is used, which can take a few minutes.",
        "On Railway's Trial and Free plans, the short idle timeout can delete a computer before its work is saved, and computers are capped at 2 GB of memory, which is tight for a desktop and Chromium. Use Hobby or Pro.",
        "Each workspace file Rakazo saves is capped at 64 MiB by default (`RAILWAY_MAX_WORKSPACE_FILE_BYTES`).",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        `Whoever owns the Railway account does this. The [Railway template](${RAILWAY_TEMPLATE_DOC}) is the quickest path and gives you a personal, [self-hosted Rakazo](/self-hosted-ai-agent/).`,
      ],
      steps: [
        "Create a Railway API token that can create environments and sandboxes. A dedicated Railway workspace is safest.",
        "Deploy the Rakazo template on Railway. Enter your email in `OWNER_EMAIL` and the token in `RAILWAY_API_TOKEN`.",
        "Wait for Rakazo to become healthy, then open its generated HTTPS domain.",
        "Sign in with your email and the generated `OWNER_PASSWORD` from the Rakazo service's Variables tab, then change the password.",
        "Connect your model account in Rakazo and send a bot a message. Its computer starts the first time it needs one.",
      ],
    },
    {
      heading: "Using Railway computers with an existing Rakazo",
      paragraphs: [
        "If Rakazo already runs somewhere else, its admin can still put the computers on Railway. Set `SANDBOX_PROVIDER=railway`, `RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID` on the API and worker, and optionally `RAILWAY_SANDBOX_REGION`. Or choose Railway in Settings → Computer and fill in the same values. The [computer providers guide](/docs/self-host-sandbox-providers/) lists every option.",
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/railway.webp",
    avif: "/graphics/sandboxes/railway.avif",
    width: 1280,
    height: 800,
    alt: "The Railway homepage, headed Ship software peacefully.",
    caption: "Railway homepage, November 4, 2026.",
  },
  faq: [
    {
      question: "Can I host Rakazo on Railway?",
      answer:
        "Yes. The Rakazo template deploys the app, a Postgres database and its bot computers into your Railway account. It's meant for a personal deployment: public registration stays closed and you sign in as the owner.",
    },
    {
      question: "Do I need E2B or another sandbox provider on Railway?",
      answer:
        "No. Railway's own sandboxes run the bot computers. You only need a Railway API token and a model account.",
    },
    {
      question: "Can Railway bot computers reach my database?",
      answer:
        "With the template, no. Computers run in a separate, empty Railway environment, so they can't reach the app's private database network. Don't put trusted services or secrets in that environment.",
    },
    {
      question: "Why choose Railway over E2B or Novita?",
      answer:
        "Everything runs in one account, from one template. If your bots need to keep programs running between sessions, [E2B](/sandboxes/e2b/) or [Novita](/sandboxes/novita/) pause computers instead of rebuilding them.",
    },
  ],
  sources: [
    { label: "Railway", href: "https://railway.com" },
    PRICING.railway,
    { label: "Railway pricing", href: "https://railway.com/pricing" },
    { label: "Railway, pricing reference", href: "https://docs.railway.com/reference/pricing" },
    { label: "Rakazo Railway template", href: RAILWAY_TEMPLATE_DOC },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
