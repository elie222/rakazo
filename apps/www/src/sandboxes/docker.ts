import { GITHUB_URL } from "../site";
import {
  BOAT,
  DOCKER_MEMORY,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  SERVERS,
  WORKDAY_HOURS,
  dockerComputersFit,
  euro,
  homepage,
  monthly,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

const fits = (gb: number) => `About ${dockerComputersFit(gb)}`;

export const docker: Sandbox = {
  slug: "docker",
  name: "Docker",
  runsOn: "Your own server or computer",
  keeps: "Each bot's home folder, on your disk",
  bestFor: "Self-hosting with no cloud account",
  title: "Run AI agents in Docker: a self-hosted sandbox for every bot, and what it costs",
  description:
    "How Rakazo runs each AI agent's computer as a locked-down Docker container on your own machine: a desktop and browser you can watch, a terminal, and files that survive restarts. Server sizing and monthly cost, security limits and setup.",
  h1: "Run AI agents in Docker, on your own machine",
  intro: [
    "An AI agent that does real work needs a computer: a browser, a terminal and somewhere to keep files. With Docker, that computer is a container on a machine you control. Nothing runs in someone else's cloud, and you don't need an account with a sandbox provider.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. When you [host Rakazo yourself](/self-hosted-ai-agent/), Docker is the default: the same install that starts Rakazo also starts your bots' computers next to it.",
  ],
  scene: {
    bot: "Talent Scout",
    color: "#3B82F6",
    where: "Computer in Docker",
    ask: "find infra engineers who maintain kubernetes operators on github, shortlist ten",
    reply: "on it. reading their repos and recent commits, notes go in your shortlist file.",
    computer: {
      task: "Reading maintainer profiles in Chromium.",
      screen: {
        host: "github.com",
        title: "Operator maintainers: shortlist",
        lines: ["48 profiles read", "10 shortlisted", "Notes saved to shortlist.md"],
      },
    },
  },
  sections: [
    {
      heading: "What is a Docker computer?",
      paragraphs: [
        "[Docker](https://www.docker.com) runs software in containers: isolated processes with their own files, network and limits, on the same machine as everything else. Rakazo uses it to give each bot computer its own container, built from a published Debian image that has a full desktop in it.",
        "A small service called the supervisor creates, starts and removes those containers. It runs inside the Rakazo install, holds the Docker socket, and is never exposed outside it. The Rakazo API asks the supervisor for a computer; it never touches Docker directly.",
        "This is Rakazo's own setup, not Docker's separate Docker Sandboxes product, and it isn't made or endorsed by Docker.",
      ],
      image: true,
    },
    {
      heading: "What Docker computers cost",
      paragraphs: [
        "Docker Engine and Rakazo are free and open source, so the cost is the machine they run on. A server costs the same whether bots work one hour a day or all day, which is the main difference from hosted sandboxes that bill by the second.",
        `Each computer is capped at ${DOCKER_MEMORY.computerGb} GB of memory and 2 CPUs by default. Most of the time a bot's desktop is waiting on the model, so memory usually runs out before CPU does. The table assumes about ${DOCKER_MEMORY.rakazoGb} GB for Rakazo itself and its database, and ${DOCKER_MEMORY.computerGb} GB for each computer.`,
      ],
      table: {
        caption: "Servers for a self-hosted Rakazo with Docker computers",
        columns: ["Server", "vCPU / memory", "Per month", "Computers that fit in memory"],
        rows: [
          { topic: "A spare Mac, PC or Linux box", cells: ["Whatever it has", "Electricity only", "Depends on its memory"] },
          { topic: "Hetzner CX33", cells: ["4 / 8 GB", euro(SERVERS.hetznerCx33), String(dockerComputersFit(8))] },
          { topic: "Hetzner CX43", cells: ["8 / 16 GB", euro(SERVERS.hetznerCx43), fits(16)] },
          { topic: "DigitalOcean Basic Droplet", cells: ["8 / 16 GB", `$${SERVERS.digitalOcean16}`, fits(16)] },
          {
            topic: "Hetzner AX42 dedicated server",
            cells: ["8 cores, 16 threads / 64 GB", `From €${SERVERS.hetznerAx42}, plus €49 setup`, `${fits(64)}, though fewer can work hard at once`],
          },
          { topic: "AWS EC2 m7i.2xlarge", cells: ["8 / 32 GB", `About $${SERVERS.awsM7i2xlarge}`, fits(32)] },
        ],
        note: `${PRICES_NOTE} Hetzner prices exclude VAT, and its cloud plans have limited stock after two price rises in 2026. AWS price for us-east-1 on demand.`,
      },
      bullets: [
        `For comparison, one 2 vCPU / 4 GB computer working 4 hours a workday costs ${usd(monthly(RATES.e2b, WORKDAY_HOURS))} on [E2B](/sandboxes/e2b/) or [Daytona](/sandboxes/daytona/), and [Boat](/sandboxes/boat/)'s minimum is $${BOAT.minimum}. A ${euro(SERVERS.hetznerCx43)} server runs Rakazo and several computers for less, but you look after it.`,
        "Computers share the server's CPU. If several bots run heavy pages at once, raise `RAKAZO_COMPUTER_CPUS` and `RAKAZO_COMPUTER_MEMORY` or pick a bigger server.",
        "Docker Engine on Linux is free for any use. On a Mac or Windows PC, Docker Desktop is free for personal use and companies under 250 employees and $10 million revenue, and costs $9 to $24 per user a month otherwise. OrbStack is $8 per user a month for commercial use.",
        "You still pay your model provider, unless you run models yourself.",
      ],
    },
    {
      heading: "What a bot can do on a Docker computer",
      paragraphs: [
        "Each computer is a small Linux desktop. The bot works on it the way a person would, and you see its screen in the chat.",
      ],
      bullets: [
        "Browse the web in Chromium, sign in to sites and download files. You can watch the screen live and take over the mouse and keyboard at any time.",
        "Run commands in a terminal, install tools and write scripts.",
        "Keep its work. Each bot's home folder lives on your server's disk, so files are still there after the computer or the whole server restarts.",
        "Share a computer with its teammates. By default, one person's bots in a space use that person's team computer, each with its own screen, and you can give a bot a private computer instead.",
        "Read folders you choose. An admin can mount host folders, such as a shared docs folder, into every computer, read-only unless they say otherwise.",
      ],
    },
    {
      heading: "When to choose Docker",
      paragraphs: [
        "Choose Docker when you want everything on hardware you own, with no sandbox account and no bot computers in anyone else's cloud. It is the quickest way to try a self-hosted Rakazo, and it suits a person or a team on a machine they trust.",
        "If you'd rather keep bots off your own server, a hosted sandbox puts their computers in someone else's cloud. [Boat](/sandboxes/boat/) is what Rakazo Cloud uses, and [E2B](/sandboxes/e2b/) pauses idle computers instead of deleting them. If you already run a cluster, [Kubernetes](/sandboxes/kubernetes/) gives you one pod per computer and lets you add gVisor or Kata for a stronger boundary. For a bot that needs your real apps and logins, see [your own computer](/sandboxes/your-computer/). The [sandbox comparison](/sandboxes/) puts every option side by side.",
      ],
    },
    {
      heading: "Limits and security",
      paragraphs: [
        "Every computer container starts with all Linux capabilities dropped and `no-new-privileges` set, so nothing inside can gain root powers. By default each one is capped at 2 GB of memory, 2 CPUs and 2048 processes, and each bot gets its own network that only the supervisor and screen proxy join.",
      ],
      bullets: [
        "A container shares your server's kernel. It is not a virtual machine, so a kernel bug could let a process escape it. If that matters to you, use a hosted provider or Kubernetes with gVisor or Kata.",
        "Restricted networking gives computers the public internet but blocks your LAN, the Docker host and cloud metadata addresses. It needs Linux Docker Engine with iptables and the host rules from `infra/compose/restrict-computer-egress.sh`. By default the stack checks for those rules and falls back to open networking without them, so a server without the rules lets bots reach your LAN. Set `SANDBOX_COMPUTER_EGRESS=restricted` to refuse to start computers instead. Docker Desktop for Mac or Windows, rootless Docker and nftables hosts can't use restricted networking. The [Docker computers guide](https://github.com/elie222/rakazo/blob/main/docs/self-host-docker-computers.md) has the details.",
        "There is no per-domain allowlist. A bot can reach any public website.",
        "Anyone who controls the supervisor controls Docker on that machine, which is why it stays on the internal network behind its own token.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for whoever runs a [self-hosted Rakazo](/self-hosted-ai-agent/). Docker computers come with the published install, so there's no extra provider to configure, and they are set by the server's environment, not in the app's Settings. If you'd rather not run a server, the [desktop app](/download/) can start the same install on your Mac or PC.",
      ],
      steps: [
        "Install Docker Engine 26 or newer with the Compose plugin on the machine that will run Rakazo.",
        "Run the installer from the [self-hosting guide](/docs/self-host/). It writes a `.env` with random secrets, including the `SANDBOX_SUPERVISOR_TOKEN` the supervisor needs, and starts Rakazo with `SANDBOX_PROVIDER=docker`.",
        "On Linux Docker Engine, let the installer apply the restricted-networking rules when it asks for sudo, or run `sudo bash infra/compose/restrict-computer-egress.sh` later.",
        "Optionally change the limits with `RAKAZO_COMPUTER_MEMORY`, `RAKAZO_COMPUTER_CPUS` and `RAKAZO_COMPUTER_PIDS_LIMIT`, or share host folders with `SANDBOX_COMPUTER_MOUNTS`, as described in [Docker computers](/docs/self-host-docker-computers/).",
        "Sign up, open a bot and open its computer to check that the desktop comes up.",
      ],
    },
  ],
  image: homepage("docker", "Docker", "The Docker homepage, headed Trust Docker for the agents you don't."),
  faq: [
    {
      question: "Is Docker safe enough for AI agents?",
      answer:
        "For a personal or team server you control, a locked-down container is a reasonable boundary. Rakazo drops every capability, blocks privilege escalation and caps memory, CPU and processes. A container still shares the host kernel, so for strangers' bots or a public instance, prefer a provider with its own kernel per computer, such as [E2B](/sandboxes/e2b/) or [Boat](/sandboxes/boat/), or Kubernetes with gVisor or Kata.",
    },
    {
      question: "Can I run AI agents in Docker on a Mac?",
      answer:
        "Yes. The Rakazo desktop app's This computer option runs the whole install in Docker Desktop or OrbStack on your Mac. Restricted networking isn't applied there, so bots can reach your local network.",
    },
    {
      question: "Is this the same as Docker Sandboxes?",
      answer:
        "No. Docker Sandboxes is Docker's own microVM product for coding agents. It is free to run locally, and its hosted Cloud Sandboxes cost $0.14 an hour for 2 vCPU / 4 GB as of November 2026. Rakazo doesn't use it; it runs its computers as ordinary containers through its own supervisor.",
    },
    {
      question: "Do I need a cloud account to run bots in Docker?",
      answer:
        "No sandbox account is needed. You still need a model, which can be a hosted API key or a model server you run yourself.",
    },
  ],
  sources: [
    { label: "Docker", href: "https://www.docker.com" },
    {
      label: "Rakazo, Docker computers",
      href: `${GITHUB_URL}/blob/main/docs/self-host-docker-computers.md`,
    },
    { label: "Rakazo, self-hosting", href: `${GITHUB_URL}/blob/main/docs/self-host.md` },
    PRICING.hetzner,
    { label: "Hetzner dedicated servers", href: "https://www.hetzner.com/dedicated-rootserver/matrix-ax/" },
    PRICING.digitalocean,
    { label: "AWS EC2 on-demand pricing", href: "https://aws.amazon.com/ec2/pricing/on-demand/" },
    { label: "Docker pricing FAQ", href: "https://www.docker.com/pricing/faq/" },
    { label: "OrbStack pricing", href: "https://orbstack.dev/pricing" },
    { label: "Docker Sandboxes", href: "https://docs.docker.com/ai/sandboxes/" },
    PRICING.dockerSandboxes,
    PRICING.e2b,
    PRICING.boat,
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
