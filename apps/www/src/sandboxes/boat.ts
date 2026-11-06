import {
  BOAT,
  BOAT_RAKAZO,
  BOAT_SIZES,
  E2B_PRO_FEE,
  METHOD_NOTE,
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  SERVERS,
  WORKDAY_HOURS,
  boatMonthly,
  euro,
  homepage,
  monthly,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

const minimumHours = Math.floor(BOAT.minimum / BOAT_RAKAZO.hour);
const fullMonth = (hour: number) => `$${Math.round(hour * 730)}`;
const shape = (size: { vcpus: number; gb: number }) => `${size.vcpus} vCPU / ${size.gb} GB`;

export const boat: Sandbox = {
  slug: "boat",
  name: "Boat",
  runsOn: "Hosted Ubuntu VM in the EU",
  keeps: "Its disk and each bot's Chrome profile",
  bestFor: "Many bots with separate logins",
  title: "Boat AI agent sandbox: pricing, limits and how Rakazo runs bots on Boat VMs",
  description:
    `Boat rents persistent Ubuntu VMs for AI agents from $${BOAT.minimum} a month. Its pricing, sizes and limits, what a bot's computer really costs compared with E2B and Daytona, and how Rakazo runs every bot on Boat.`,
  h1: "Boat for AI agents: a cloud computer for every bot",
  intro: [
    "[Boat](https://boat.dev) rents out persistent Ubuntu virtual machines built for AI agents. Each one is a full Linux computer in the cloud that keeps its disk when it stops, so an agent can come back to the same files and installed tools later.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. Rakazo Cloud runs those computers on Boat, and if you host Rakazo yourself you can point it at your own Boat account. Boat supplies the machine. Rakazo puts the desktop on it, gives each bot its own screen and browser, and decides when to start and stop it.",
  ],
  scene: {
    bot: "Sales Outbound",
    color: "#F5A03C",
    where: "Computer on Boat",
    ask: "work the seed-stage fintech list overnight, nothing sent without me",
    reply: "on it. signed in to hubspot and linkedin in my own browser. drafts will wait for you at 6am.",
    computer: {
      task: "Scoring the list in HubSpot.",
      screen: {
        host: "app.hubspot.com",
        title: "Seed-stage fintech: review list",
        lines: ["40 accounts scored", "22 LinkedIn profiles read", "18 drafts queued"],
      },
    },
  },
  sections: [
    {
      heading: "What is Boat?",
      paragraphs: [
        "[Boat](https://boat.dev) is a Y Combinator company that runs cloud VMs for agents. Its machines are Ubuntu VMs in EU regions. Unlike a short-lived code sandbox, a Boat machine is meant to stay around: you can stop it, and when it resumes the disk is still there.",
        "That makes it a good fit for an agent that works like a person at a desk. It signs in to websites, saves files and installs tools, and it expects all of that to still be there tomorrow.",
        "Machines run in Germany, Finland and France. Boat doesn't name the hypervisor; each machine is a full VM rather than a container, with Docker available inside.",
      ],
      image: true,
    },
    {
      heading: "Boat pricing",
      paragraphs: [
        `Boat bills machines by the second while they run, with a $${BOAT.minimum} minimum a month that counts entirely as machine time. Stopped machines don't bill for compute. New accounts get a 7-day trial with 25 compute hours.`,
      ],
      table: {
        caption: "Boat machine sizes as of November 2026",
        columns: ["Size", "vCPU / memory / disk", "Per hour", "Full month"],
        rows: [
          { topic: "small", cells: [`${BOAT.small.vcpus} / ${BOAT.small.gb} GB / 51 GB`, `$${BOAT.small.hour}`, fullMonth(BOAT.small.hour)] },
          { topic: "default", cells: [`${BOAT.default.vcpus} / ${BOAT.default.gb} GB / 51 GB`, `$${BOAT.default.hour}`, fullMonth(BOAT.default.hour)] },
          { topic: "large", cells: [`${BOAT.large.vcpus} / ${BOAT.large.gb} GB / 111 GB`, `$${BOAT.large.hour}`, fullMonth(BOAT.large.hour)] },
          {
            topic: "xlarge",
            cells: [`${BOAT.xlarge.vcpus} / ${BOAT.xlarge.gb} GB / 251 GB`, `$${BOAT.xlarge.hour.toFixed(3)}`, `${fullMonth(BOAT.xlarge.hour)}, on plans of $100 or more`],
          },
        ],
        note: `${PRICES_NOTE} Source: [boat.dev](https://boat.dev).`,
      },
      bullets: [
        `The $${BOAT.minimum} minimum buys about ${minimumHours} hours of the default size.`,
        "Saved snapshots cost $0.056 a day each. Rakazo keeps one base snapshot with the desktop tools installed, about $1.70 a month.",
        "Starting machines faster than your plan's limit costs $0.03 to $0.07 a start.",
        "Plans allow 100 to 2,000 machines running at once.",
      ],
    },
    {
      heading: "What a Rakazo computer costs on Boat",
      paragraphs: [
        `${METHOD_NOTE} Rakazo can't run Boat at that size: its smallest Boat machine is the default ${shape(BOAT_RAKAZO)}, so the table compares that size on providers that bill per second. Because Boat is cheap per hour and has a monthly minimum, most people and small teams pay exactly $${BOAT.minimum}: the minimum covers all the computers on one Boat account.`,
      ],
      table: {
        caption: `One ${shape(BOAT_RAKAZO)} computer a month`,
        columns: ["Provider", "4 hours a workday (88 hours)", "Around the clock (720 hours)"],
        rows: [
          {
            topic: "Boat",
            cells: [
              `${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))}, the minimum (${usd(BOAT_RAKAZO.hour * WORKDAY_HOURS)} of usage)`,
              usd(boatMonthly(BOAT_RAKAZO.hour, MONTH_HOURS)),
            ],
          },
          {
            topic: "[Novita](/sandboxes/novita/)",
            cells: [usd(monthly(RATES.novita, WORKDAY_HOURS, BOAT_RAKAZO)), usd(monthly(RATES.novita, MONTH_HOURS, BOAT_RAKAZO))],
          },
          {
            topic: "[E2B](/sandboxes/e2b/)",
            cells: [
              usd(monthly(RATES.e2b, WORKDAY_HOURS, BOAT_RAKAZO)),
              `${usd(monthly(RATES.e2b, MONTH_HOURS, BOAT_RAKAZO))}, or ${usd(monthly(RATES.e2b, MONTH_HOURS, BOAT_RAKAZO) + E2B_PRO_FEE)} with Pro for 24-hour sessions`,
            ],
          },
          {
            topic: "[Daytona](/sandboxes/daytona/)",
            cells: [usd(monthly(RATES.daytona, WORKDAY_HOURS, BOAT_RAKAZO)), usd(monthly(RATES.daytona, MONTH_HOURS, BOAT_RAKAZO))],
          },
          {
            topic: "[Docker](/sandboxes/docker/) on a rented server",
            cells: [`${euro(SERVERS.hetznerCx33)} for a 4 vCPU / 8 GB Hetzner CX33`, euro(SERVERS.hetznerCx33)],
          },
        ],
        note: "Computed from each provider's rates, checked November 2026, before free credits. Daytona caps one sandbox at 4 vCPU / 8 GiB. The Docker server also has to run Rakazo itself. Your model provider bills separately.",
      },
    },
    {
      heading: "Which Boat size Rakazo uses",
      paragraphs: [
        "Rakazo picks a computer's size from its organization's Rakazo Cloud plan. A self-hosted install has no size setting, so its computers always use Boat's default machine. When the plan changes, a running computer keeps its size and moves to the new one the next time Rakazo starts it after a stop; if Boat refuses that size, it starts at the size it had.",
      ],
      table: {
        caption: "Boat machines by Rakazo computer size",
        columns: ["Used for", "Boat machine", `${WORKDAY_HOURS} hours a month`, "Around the clock"],
        rows: BOAT_SIZES.map((size) => ({
          topic: size.plan,
          cells: [
            `${size.machine}, ${shape(size)}`,
            usd(boatMonthly(size.hour, WORKDAY_HOURS)),
            usd(boatMonthly(size.hour, MONTH_HOURS)),
          ],
        })),
        note: "What Boat charges for one machine, from its rates checked November 2026, with the monthly minimum applied. Boat offers xlarge only on plans of $100 or more. On Rakazo Cloud you pay Rakazo, not Boat; the [pricing page](/pricing/) lists the computer hours each plan includes.",
      },
    },
    {
      heading: "What your bots can do on a Boat computer",
      paragraphs: [
        "When Rakazo runs on Boat, each bot works on a real Linux desktop. You see what it sees in the chat, and you can take the mouse and keyboard whenever you want.",
      ],
      bullets: [
        "Use a Chrome browser that is only theirs. Each bot keeps its own persistent Chrome profile, so a sales bot's HubSpot login is never visible to the inbox bot.",
        "Read web pages as text as well as by screenshot. On Boat, Rakazo installs a page-reading helper so bots can follow links and fill forms without guessing from pixels.",
        "Run shell commands, read and write files, and open a terminal you can type in yourself.",
        "Share one computer. By default, one person's bots in a space share that person's team computer, each on its own screen. A bot can have a computer of its own instead.",
        "Pick up where they left off. Stopping a computer keeps its disk, and Rakazo also saves each bot's workspace and browser profile on its own side.",
      ],
    },
    {
      heading: "When to choose Boat",
      paragraphs: [
        "Choose Boat when you want hosted computers that behave like long-lived machines, and your bots sign in to many different sites. It is what Rakazo Cloud uses, so it is the most exercised path for that kind of work.",
        "[E2B](/sandboxes/e2b/) is the other well-tested hosted option. It pauses idle computers, and Rakazo's live computer test runs on it. [Novita](/sandboxes/novita/) pauses with memory, so open programs survive a stop. [Daytona](/sandboxes/daytona/) suits teams that already have an account there. If you don't want a cloud account at all, [Docker](/sandboxes/docker/) runs computers on your own server. The [sandbox comparison](/sandboxes/) puts them all side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Boat's regions are in the EU, and Rakazo doesn't offer a region choice, a machine size or a custom image for Boat on a self-hosted install.",
        "Boat is a young company. Its code isn't open source, and you can't run it on your own machines.",
        "Stopping keeps the disk but not running programs. A long job that was running when the computer stopped has to start again.",
        "Until Rakazo's base snapshot is ready, new computers install the desktop tools themselves, so the first ones start more slowly.",
        "Rakazo creates every Boat machine without your account's environment variables, so nothing from your Boat account leaks into a bot's computer. Anything a bot needs has to come through Rakazo.",
        "Like other hosted providers that bill while running, a computer is stopped after two hours of continuous uptime by default unless a bot is still working on it or you are in control.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "On Rakazo Cloud there is nothing to set up: bot computers already run on Boat. These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/).",
      ],
      steps: [
        "Create a Boat account at [boat.dev](https://boat.dev) and make an API key.",
        "Either set `SANDBOX_PROVIDER=boat` and `BOAT_API_KEY` on the Rakazo API and worker, or sign in as an admin and choose Boat under Settings → Computer, then paste the key. `BOAT_API_URL` is optional.",
        "Optionally run `pnpm sandbox:boat-snapshot` with the same key to build the base snapshot ahead of time. If you skip it, Rakazo builds it once in the background.",
        "Open a bot's computer in Rakazo to check that the desktop comes up.",
      ],
    },
  ],
  image: homepage(
    "boat",
    "Boat",
    "The Boat homepage, headed Most powerful and affordable cloud VMs for agents.",
  ),
  faq: [
    {
      question: "Boat vs E2B for AI agents?",
      answer: `Both give Rakazo bots a Linux desktop, terminal and files. Boat machines are long-lived VMs that keep their disk when stopped, cost a flat $${BOAT.minimum} minimum for most small teams, and Rakazo Cloud runs on them. [E2B](/sandboxes/e2b/) bills every second at a higher rate, pauses idle sandboxes with their memory, runs in the US, and is open source. Rakazo keeps its own copy of each bot's workspace on both.`,
    },
    {
      question: "Do I need Boat to self-host Rakazo?",
      answer:
        "No. [Docker](/sandboxes/docker/) is the default and needs no cloud account. Boat is one optional place to run bot computers.",
    },
  ],
  sources: [
    PRICING.boat,
    { label: "Boat docs, pricing", href: "https://docs.boat.dev/pricing" },
    PRICING.e2b,
    PRICING.daytona,
    PRICING.novita,
    PRICING.hetzner,
    PRICING.rakazo,
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
