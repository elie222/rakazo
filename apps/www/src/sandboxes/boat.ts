import { PROVIDERS_DOC, RUNTIME_DOC, homepage } from "./shared";
import type { Sandbox } from "./types";

export const boat: Sandbox = {
  slug: "boat",
  name: "Boat",
  runsOn: "Hosted Ubuntu VM in the EU",
  keeps: "Its disk and each bot's Chrome profile",
  bestFor: "Many bots with separate logins",
  title: "Boat AI agent sandbox: Linux VMs for Rakazo bots",
  description:
    "What Boat is, and how Rakazo runs AI agents on Boat VMs: a desktop you can watch, a terminal, and a separate Chrome profile for every bot. Setup, limits and FAQ.",
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
    task: "Scoring the list in HubSpot.",
    screen: {
      host: "app.hubspot.com",
      title: "Seed-stage fintech: review list",
      lines: ["40 accounts scored", "22 LinkedIn profiles read", "18 drafts queued"],
    },
  },
  sections: [
    {
      heading: "What is Boat?",
      paragraphs: [
        "[Boat](https://boat.dev) is a Y Combinator company that runs cloud VMs for agents. Its machines are Ubuntu VMs in EU regions. Unlike a short-lived code sandbox, a Boat machine is meant to stay around: you can stop it, and when it resumes the disk is still there.",
        "That makes it a good fit for an agent that works like a person at a desk. It signs in to websites, saves files and installs tools, and it expects all of that to still be there tomorrow.",
      ],
      image: true,
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
        "Share one computer. Bots in a workspace share a team computer by default, and each one gets its own screen on it.",
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
        "Boat's regions are in the EU, and Rakazo doesn't offer a region choice or a custom image for Boat.",
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
      question: "What is Boat used for?",
      answer:
        "Running AI agents on persistent Linux VMs in the cloud. Rakazo uses Boat as the computer each bot works on, with a desktop, browser, terminal and files.",
    },
    {
      question: "Can AI agents use a browser on Boat?",
      answer:
        "Yes. In Rakazo each bot gets its own Chrome on a Boat desktop, with a persistent profile, and you can watch it or take over. Logins are not shared between bots.",
    },
    {
      question: "Do Boat computers see my server's environment variables?",
      answer:
        "No. Rakazo always creates and resumes Boat machines without the account's environment, so your keys don't end up inside a bot's computer.",
    },
    {
      question: "Boat vs E2B for AI agents?",
      answer:
        "Both give Rakazo bots a Linux desktop, terminal and files. Boat machines are long-lived VMs that keep their disk when stopped, and Rakazo Cloud runs on them. [E2B](/sandboxes/e2b/) pauses idle sandboxes and is open source. Rakazo keeps its own copy of each bot's workspace on both.",
    },
    {
      question: "Do I need Boat to self-host Rakazo?",
      answer:
        "No. [Docker](/sandboxes/docker/) is the default and needs no cloud account. Boat is one optional place to run bot computers.",
    },
  ],
  sources: [
    { label: "Boat", href: "https://boat.dev" },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
