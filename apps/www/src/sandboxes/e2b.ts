import { HOSTED_SANDBOXES_TABLE } from "./compare";
import { PRICES_NOTE, PRICING, PROVIDERS_DOC, RUNTIME_DOC, homepage } from "./shared";
import type { Sandbox } from "./types";

export const e2b: Sandbox = {
  slug: "e2b",
  name: "E2B",
  runsOn: "Hosted Linux sandbox",
  keeps: "Its files, paused with the computer",
  bestFor: "Public or multi-user deployments",
  title: "E2B pricing, limits and alternatives in 2026: E2B vs Daytona, Modal and Vercel",
  description:
    "E2B sandbox pricing explained: the free tier, the $150 Pro plan, per-second rates and what an AI agent's desktop really costs a month. Plus E2B vs Daytona, Modal and Vercel, and how Rakazo runs bots on E2B.",
  h1: "E2B for AI agents: pricing, limits and alternatives",
  intro: [
    "[E2B](https://e2b.dev) is an open source cloud for running AI agents in isolated sandboxes. Each sandbox is a small Linux virtual machine in E2B's cloud, so agent code and commands never run on your own server.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. E2B can be the place those computers live when you host Rakazo yourself. E2B supplies the sandbox. Rakazo puts each bot's screen on it, saves its work, and pauses it when nobody is using it.",
    "This page covers what E2B costs as of November 2026, the limits that matter for a bot that works for hours, and how it compares with Daytona, Modal, Vercel Sandbox and the other options.",
  ],
  scene: {
    bot: "Bug Triage",
    color: "#D9508A",
    where: "Computer on E2B",
    ask: "checkout is throwing 500s since the deploy, find out why?",
    reply: "on it. reproducing in the browser and reading the logs in my terminal.",
    computer: {
      task: "Reproducing the checkout error.",
      screen: {
        host: "localhost:3000",
        title: "Checkout: 500 on submit",
        lines: ["Reproduced on first try", "Null coupon in cart total", "Fix drafted · tests pass"],
      },
    },
  },
  sections: [
    {
      heading: "What is E2B?",
      paragraphs: [
        "[E2B](https://e2b.dev) runs sandboxes for AI agents as a hosted service. Each sandbox is a Firecracker microVM, a lightweight virtual machine with its own kernel, so what an agent does inside it stays inside it. Firecracker is the same technology AWS Lambda runs on. The SDKs and the sandbox runtime are open source under the Apache-2.0 license.",
        "Sandboxes start from templates, can be paused with their memory and files and resumed later, and are billed per second only while they run. E2B also publishes a desktop sandbox with a graphical Linux desktop, which is what Rakazo builds on. E2B reports SOC 2 Type II, and runs in the US by default, with Europe and Asia available on request.",
      ],
      image: true,
    },
    {
      heading: "E2B pricing",
      paragraphs: [
        "E2B charges for the CPU and memory a sandbox has while it runs, by the second, plus a monthly fee on paid plans. Disk is included. A paused sandbox stops billing for compute. The free Hobby plan has no monthly fee and a one-time $100 credit, with no card needed.",
      ],
      table: {
        caption: "E2B plans as of November 2026",
        columns: ["Plan", "Monthly fee", "Usage", "Longest session", "Running at once"],
        rows: [
          {
            topic: "Hobby",
            cells: [
              "$0, with a one-time $100 credit",
              "$0.000014 per vCPU-second, $0.0000045 per GiB-second",
              "1 hour",
              "20",
            ],
          },
          {
            topic: "Pro",
            cells: [
              "$150",
              "Same rates",
              "24 hours",
              "100, or 600 and 1,100 with add-ons at $650 and $1,150 a month",
            ],
          },
          { topic: "Enterprise", cells: ["Custom, $3,000 monthly minimum", "Custom", "Custom", "Custom"] },
        ],
        note: `${PRICES_NOTE} Hobby includes 10 GiB of disk per sandbox and Pro 20 GiB. E2B has no GPU sandboxes. Source: [E2B pricing](https://e2b.dev/pricing).`,
      },
      bullets: [
        "In hourly terms that is about $0.05 per vCPU and $0.016 per GiB of memory, so the default 2 vCPU / 4 GiB sandbox costs about $0.17 an hour.",
        "Upgrading to Pro doesn't add credit. The $150 buys longer sessions, more sandboxes at once and custom CPU and memory sizes.",
        "Pausing takes about 4 seconds per GiB of memory and resuming about a second. A paused sandbox is kept until you delete it.",
      ],
    },
    {
      heading: "What a Rakazo computer costs on E2B",
      paragraphs: [
        "Rakazo builds a `rakazo-computer` template at 2 vCPU and 4 GB, which is enough for a Linux desktop, Chromium and a terminal. Bots in a workspace share one team computer by default, so this is usually the cost for a whole team, not for each bot.",
        "Rakazo pauses an E2B computer after 10 minutes without use, and after two hours of continuous uptime unless a bot is still working or you are in control. You pay for the hours bots actually work, plus a short idle tail.",
      ],
      table: {
        caption: "One 2 vCPU / 4 GB computer on E2B",
        columns: ["How long it runs", "On Hobby", "On Pro"],
        rows: [
          { topic: "One hour", cells: ["$0.17", "$0.17, plus the $150 fee"] },
          {
            topic: "4 hours a workday, 88 hours a month",
            cells: ["$14.57. The $100 credit lasts about six months", "$164.57"],
          },
          {
            topic: "Around the clock, 720 hours",
            cells: ["Not possible: a session ends after an hour", "$269.23"],
          },
        ],
        note: "Computed from E2B's per-second rates, checked November 2026, before the free credit. Your model provider bills separately.",
      },
      bullets: [
        "If you skip the template build, Rakazo falls back to E2B's stock desktop template, which reserves 8 vCPU and 8 GB. That is about $0.53 an hour, more than three times as much.",
        "On Rakazo Cloud you don't pay E2B at all. Cloud computers run on [Boat](/sandboxes/boat/) and are included in the [plan](/pricing/).",
      ],
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
      heading: "E2B vs Daytona, Modal, Vercel and other alternatives",
      paragraphs: [
        "Most E2B alternatives charge almost the same for compute. E2B and Daytona use identical per-second rates. The real differences are isolation, how long a session may run, what survives a stop, and whether you can run it yourself. The table prices the same 2 vCPU / 4 GB computer for 88 hours a month everywhere.",
      ],
      table: HOSTED_SANDBOXES_TABLE,
      bullets: [
        "**E2B vs Daytona.** Same price per second, but Daytona has no monthly fee and no session cap, while E2B needs the $150 Pro plan for sessions over an hour. E2B gives every sandbox its own kernel; Daytona's default sandboxes are containers that share the host's kernel. E2B is open source; [Daytona](/sandboxes/daytona/) closed its source in June 2026.",
        "**E2B vs Modal.** Modal Sandboxes run on gVisor and cost about 45% more for this computer, but the free plan's $30 monthly credit covers light use and Modal has GPUs. Rakazo doesn't support Modal.",
        "**E2B vs Vercel Sandbox.** Both are Firecracker microVMs. Vercel bills CPU only while it is busy, which is cheap for a bot that mostly waits on a model, and keeps the filesystem when stopped but not running programs. Rakazo doesn't support Vercel Sandbox.",
        "**Cheaper per hour.** Northflank lists the lowest rate for this size and can run in your own cloud. [Novita](/sandboxes/novita/) works with the E2B SDK at about 30% less and pauses with memory too.",
        "**Not per hour at all.** [Boat](/sandboxes/boat/) is a flat $20 minimum a month that covers hundreds of hours. [Docker](/sandboxes/docker/) on a server you rent costs the same however much the bots work.",
      ],
    },
    {
      heading: "When to choose E2B",
      paragraphs: [
        "Choose E2B when you self-host Rakazo for other people, such as a team or a public instance, and you don't want bots running on the same server as Rakazo. Rakazo's own setup docs suggest it for that case, and Rakazo's live computer acceptance test runs on E2B. It is also the safest bet if open source matters to you: if E2B the company disappeared, the code would not.",
        "Look elsewhere if your bots run long jobs and you don't want the $150 Pro fee, or if your team is small and price matters more than the microVM boundary. [Boat](/sandboxes/boat/) is what Rakazo Cloud runs on: long-lived VMs that keep their disk when stopped. [Novita](/sandboxes/novita/) uses a similar sandbox model and keeps open programs in memory when it pauses. [Daytona](/sandboxes/daytona/) suits teams already on it. For no cloud account at all, use [Docker](/sandboxes/docker/) on your own machine, or [Kubernetes](/sandboxes/kubernetes/) on a cluster you run. The [sandbox comparison](/sandboxes/) has them all side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "On Hobby a session lasts at most one hour and 20 sandboxes can run at once. Pro raises that to 24 hours and 100. Pausing and resuming starts a new session.",
        "Rakazo doesn't expose a region choice, a custom image, or E2B's own snapshots, volumes or network rules.",
        "Computers use the `rakazo-computer` template at 2 vCPU and 4 GB once you build it. Before that, they use E2B's stock desktop, which reserves 8 vCPU and 8 GB each.",
        "An existing computer keeps the size it was created with until it is replaced.",
        "Like other hosted providers that bill while running, a computer is paused after two hours of continuous uptime by default unless a bot is still working on it or you are in control.",
        "Public status pages recorded short E2B outages in 2026, such as a few minutes of failed sandbox starts in March and August. Rakazo keeps the saved workspace, so a failed start loses no work.",
      ],
    },
    {
      heading: "Can you self-host E2B?",
      paragraphs: [
        "Yes, with effort. E2B's runtime is open source and runs on Linux machines with KVM, using Terraform on AWS or Google Cloud, Kubernetes, or a single-node package. E2B also offers a managed deployment inside your own AWS, Google Cloud or Azure account on Enterprise. Rakazo's settings take only an API key for E2B's hosted service; pointing it at a self-hosted E2B isn't a documented setup. If you want everything on your own machines, Rakazo's [Docker](/sandboxes/docker/) and [Kubernetes](/sandboxes/kubernetes/) computers are the simpler path.",
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
      question: "Is the E2B sandbox free?",
      answer:
        "There is a free Hobby plan with a one-time $100 usage credit and no card needed. After the credit, you pay per second of use. Hobby sessions last up to an hour; longer ones need the $150 a month Pro plan.",
    },
    {
      question: "How much does E2B cost per hour?",
      answer:
        "$0.000014 per vCPU-second and $0.0000045 per GiB-second as of November 2026, so a 2 vCPU / 4 GiB sandbox costs about $0.17 an hour while running. Paused sandboxes don't bill for compute.",
    },
    {
      question: "Does E2B use Firecracker?",
      answer:
        "Yes. Every E2B sandbox is a Firecracker microVM with its own kernel, which is a stronger boundary than a container that shares the host's kernel.",
    },
    {
      question: "Is E2B open source?",
      answer:
        "Yes. E2B's SDKs and runtime are on [GitHub](https://github.com/e2b-dev/E2B) under the Apache-2.0 license, and you can run the runtime yourself. Rakazo uses E2B's hosted service through its API key.",
    },
    {
      question: "E2B vs Daytona: which is better for AI agents?",
      answer:
        "They cost the same per second. E2B gives each sandbox its own kernel, pauses with memory, and is open source, but sessions over an hour need Pro. [Daytona](/sandboxes/daytona/) has no plan fee or session cap and keeps the disk when stopped. In Rakazo, E2B starts from a ready desktop template; on Daytona the first start installs the desktop, and waking an archived computer can take several minutes.",
    },
    {
      question: "What are the best E2B alternatives?",
      answer:
        "For Rakazo bots: [Boat](/sandboxes/boat/) for a flat monthly price, [Novita](/sandboxes/novita/) for the E2B model at a lower rate, [Daytona](/sandboxes/daytona/) with no session cap, or [Docker](/sandboxes/docker/) for no cloud account. Outside Rakazo, Modal, Vercel Sandbox and Northflank are the common picks; the comparison table above prices them all.",
    },
    {
      question: "What happens when a bot's E2B computer is idle?",
      answer:
        "It pauses after 10 minutes without use by default, and stops billing for compute. The next time the bot needs it, the same computer resumes. Removing the computer deletes it.",
    },
    {
      question: "Do I need E2B to run Rakazo?",
      answer:
        "No. [Docker](/sandboxes/docker/) is the default when you self-host and needs no cloud account. E2B is one optional place to run bot computers.",
    },
  ],
  sources: [
    { label: "E2B", href: "https://e2b.dev" },
    PRICING.e2b,
    { label: "E2B, persistence", href: "https://docs.e2b.dev/sandbox/persistence" },
    { label: "E2B security", href: "https://e2b.dev/security" },
    { label: "E2B on GitHub", href: "https://github.com/e2b-dev/E2B" },
    { label: "E2B runtime on GitHub", href: "https://github.com/e2b-dev/runtime" },
    { label: "E2B status", href: "https://status.e2b.dev" },
    PRICING.daytona,
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
