import { PROVIDERS_DOC, RUNTIME_DOC, homepage } from "./shared";
import type { Sandbox } from "./types";

export const e2b: Sandbox = {
  slug: "e2b",
  name: "E2B",
  runsOn: "Hosted Linux sandbox",
  keeps: "Its files, paused with the computer",
  bestFor: "Public or multi-user deployments",
  title: "E2B AI agent sandbox: desktops for Rakazo bots on E2B",
  description:
    "What E2B is, and how Rakazo runs AI agents in E2B sandboxes: a Linux desktop and browser you can watch and take over, paused when idle. Setup, limits and FAQ.",
  h1: "E2B for AI agents: a desktop sandbox for every bot",
  intro: [
    "[E2B](https://e2b.dev) is an open source cloud for running AI agents in isolated sandboxes. Each sandbox is a small Linux machine in E2B's cloud, so agent code and commands never run on your own server.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. E2B can be the place those computers live when you host Rakazo yourself. E2B supplies the sandbox. Rakazo puts each bot's screen on it, saves its work, and pauses it when nobody is using it.",
  ],
  scene: {
    bot: "Bug Triage",
    color: "#D9508A",
    where: "Computer on E2B",
    ask: "checkout is throwing 500s since the deploy, find out why?",
    reply: "on it. reproducing in the browser and reading the logs in my terminal.",
    task: "Reproducing the checkout error.",
    screen: {
      host: "localhost:3000",
      title: "Checkout: 500 on submit",
      lines: ["Reproduced on first try", "Null coupon in cart total", "Fix drafted · tests pass"],
    },
  },
  sections: [
    {
      heading: "What is E2B?",
      paragraphs: [
        "[E2B](https://e2b.dev) runs sandboxes for AI agents as a hosted service. Each sandbox is a Firecracker microVM, a lightweight virtual machine with its own kernel, so what an agent does inside it stays inside it. The code is open source under the Apache-2.0 license.",
        "E2B also publishes a desktop sandbox with a graphical Linux desktop, which is what Rakazo builds on. Sandboxes can be paused and resumed later with their files intact.",
      ],
      image: true,
    },
    {
      heading: "What your bots can do on an E2B computer",
      paragraphs: [
        "On E2B, each Rakazo bot works on a real Linux desktop. You see its screen in the chat and can take the mouse and keyboard at any time.",
      ],
      bullets: [
        "Browse the web in Chromium, with its own screen and browser profile. Signed-in sessions stay between runs.",
        "Run shell commands, read and write files, and open a terminal you can type in yourself.",
        "Share one computer. Bots in a workspace share a team computer by default, and each one gets its own screen on it.",
        "Come back to the same machine. An idle computer pauses instead of being deleted, and resumes with its files the next time a bot needs it.",
        "Survive a lost sandbox. Rakazo keeps its own copy of each bot's workspace, so the E2B disk is a cache. If a sandbox disappears, a new one starts from the saved work.",
      ],
    },
    {
      heading: "When to choose E2B",
      paragraphs: [
        "Choose E2B when you self-host Rakazo for other people, such as a team or a public instance, and you don't want bots running on the same server as Rakazo. Rakazo's own setup docs suggest it for that case, and Rakazo's live computer acceptance test runs on E2B.",
        "[Boat](/sandboxes/boat/) is what Rakazo Cloud runs on: long-lived VMs that keep their disk when stopped. [Novita](/sandboxes/novita/) uses a similar sandbox model and keeps open programs in memory when it pauses. [Daytona](/sandboxes/daytona/) suits teams already on it. For no cloud account at all, use [Docker](/sandboxes/docker/) on your own machine, or [Kubernetes](/sandboxes/kubernetes/) on a cluster you run. The [sandbox comparison](/sandboxes/) has them all side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Rakazo doesn't expose a region choice, a custom image, or E2B's own snapshots, volumes or network rules.",
        "Computers use the `rakazo-computer` template at 2 vCPU and 4 GB once you build it. Before that, they use E2B's stock desktop, which reserves 8 vCPU and 8 GB each.",
        "An existing computer keeps the size it was created with until it is replaced.",
        "Like other hosted providers that bill while running, a computer is paused after two hours of continuous uptime by default unless a bot is still working on it or you are in control.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/). Rakazo Cloud users don't need an E2B account.",
      ],
      steps: [
        "Create an account at [e2b.dev](https://e2b.dev) and copy an API key.",
        "Either set `SANDBOX_PROVIDER=e2b` and `E2B_API_KEY` on the Rakazo API and worker, or sign in as an admin and choose E2B under Settings → Computer, then paste the key.",
        "Build the smaller template once with `E2B_API_KEY=<your key> pnpm sandbox:e2b-template`, in the E2B team that owns the key. Run it again when Rakazo's template definition changes.",
        "Open a bot's computer in Rakazo to check that the desktop comes up.",
      ],
    },
  ],
  image: homepage("e2b", "E2B", "The E2B homepage, headed Every agent gets a machine."),
  faq: [
    {
      question: "Is E2B open source?",
      answer:
        "Yes. E2B's code is on [GitHub](https://github.com/e2b-dev/E2B) under the Apache-2.0 license. Rakazo uses E2B's hosted service through its API key.",
    },
    {
      question: "Can AI agents use a browser in E2B?",
      answer:
        "Yes. Rakazo runs a Linux desktop with Chromium in each E2B sandbox. Every bot gets its own screen and browser profile, and you can watch it or take over.",
    },
    {
      question: "E2B vs Daytona for AI agents?",
      answer:
        "Both run Rakazo bot computers with a desktop, terminal and files. E2B starts from a desktop template, and idle computers pause and resume as the same machine. On [Daytona](/sandboxes/daytona/), the first start installs the desktop, and waking an archived computer can take several minutes. E2B is open source; Daytona's public repository is archived.",
    },
    {
      question: "What happens when a bot's E2B computer is idle?",
      answer:
        "It pauses after 10 minutes without use by default. The next time the bot needs it, the same computer resumes. Removing the computer deletes it.",
    },
    {
      question: "Do I need E2B to run Rakazo?",
      answer:
        "No. [Docker](/sandboxes/docker/) is the default when you self-host and needs no cloud account. E2B is one optional place to run bot computers.",
    },
  ],
  sources: [
    { label: "E2B", href: "https://e2b.dev" },
    { label: "E2B on GitHub", href: "https://github.com/e2b-dev/E2B" },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
