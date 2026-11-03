import type { FaqItem, SourceLink } from "./alternatives";
import { GITHUB_URL } from "./site";

export const SANDBOXES_PATH = "/sandboxes/";
export const SANDBOXES_UPDATED = "November 4, 2026";
export const COMPUTER_PROVIDERS_DOCS_PATH = "/docs/self-host-sandbox-providers/";

export type SandboxImage = {
  webp: string;
  avif?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
};

export type Sandbox = {
  /** Path segment. The page is served at `/sandboxes/${slug}/`. */
  slug: string;
  /** Short name used in the footer and in links between sandbox pages. */
  name: string;
  title: string;
  description: string;
  h1: string;
  intro: readonly string[];
  image: SandboxImage;
  /** What a bot's computer gets on this provider. Each item traces to the adapter. */
  works: readonly string[];
  /** What it does not do, stated plainly. */
  limits: readonly string[];
  setup: readonly string[];
  faq: readonly FaqItem[];
  sources: readonly SourceLink[];
};

function homepage(slug: string, provider: string, alt: string): SandboxImage {
  return {
    webp: `/graphics/sandboxes/${slug}.webp`,
    avif: `/graphics/sandboxes/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `${provider} homepage, ${SANDBOXES_UPDATED}.`,
  };
}

const PROVIDERS_DOC: SourceLink = {
  label: "Rakazo, computer providers",
  href: `${GITHUB_URL}/blob/main/docs/self-host-sandbox-providers.md`,
};

const RUNTIME_DOC: SourceLink = {
  label: "Rakazo, computer runtime and isolation",
  href: `${GITHUB_URL}/blob/main/docs/computer-runtime.md`,
};

export const SANDBOXES: readonly Sandbox[] = [
  {
    slug: "e2b",
    name: "E2B",
    title: "E2B for AI agents: run Rakazo bot computers on E2B",
    description:
      "Give each Rakazo bot a Linux desktop on E2B. Screen, terminal, files and browser, paused instead of deleted when idle.",
    h1: "Run your AI agents' computers on E2B",
    intro: [
      "E2B runs isolated Linux sandboxes for AI agents. Rakazo can use it as the place where your bots' computers live, so their desktops, browsers and commands run in E2B instead of on your server.",
      "Rakazo's live computer acceptance test runs on E2B, and the self-hosting docs suggest it for public or multi-user deployments.",
    ],
    image: homepage("e2b", "E2B", "The E2B homepage, headed Every agent gets a machine."),
    works: [
      "A Linux desktop you can watch live and take over, with several bots' screens on one computer.",
      "Shell commands, a terminal, and reading and writing files.",
      "Idle computers pause instead of being deleted, and resume where they left off.",
      "Rakazo keeps its own copy of each workspace, so the E2B disk is a cache rather than the only copy.",
    ],
    limits: [
      "No region choice, custom image, or E2B snapshots, volumes or egress rules from Rakazo.",
      "Computers use a fixed template, `rakazo-computer`, at 2 vCPU and 4 GB.",
    ],
    setup: [
      "Set `SANDBOX_PROVIDER=e2b` and `E2B_API_KEY` on the API and worker, or choose E2B in Settings → Computer as an admin.",
      "Build the smaller template once with `pnpm sandbox:e2b-template`. Until then, computers use E2B's larger stock desktop.",
    ],
    faq: [
      {
        question: "Do I need E2B to run Rakazo?",
        answer:
          "No. Docker is the default and needs no cloud account. E2B is one optional place to run bot computers.",
      },
      {
        question: "What happens when a bot's E2B computer is idle?",
        answer:
          "It pauses. The next time the bot needs it, the same computer resumes. Removing the computer deletes it.",
      },
    ],
    sources: [
      { label: "E2B", href: "https://e2b.dev" },
      { label: "E2B on GitHub", href: "https://github.com/e2b-dev/E2B" },
      PROVIDERS_DOC,
      RUNTIME_DOC,
    ],
  },
  {
    slug: "daytona",
    name: "Daytona",
    title: "Daytona for AI agents: run Rakazo bot computers on Daytona",
    description:
      "Give each Rakazo bot a Linux desktop in a Daytona sandbox. Screen, commands and files, stopped by Rakazo when idle.",
    h1: "Run your AI agents' computers on Daytona",
    intro: [
      "Daytona runs sandboxes for AI-generated code. Rakazo can use it as the place where your bots' computers live, with a desktop each bot works in.",
      "Rakazo, not Daytona, decides when a computer stops: sandboxes are created without Daytona's auto-stop or auto-delete, and Rakazo's idle timer stops them.",
    ],
    image: homepage("daytona", "Daytona", "The Daytona homepage, headed Run AI code."),
    works: [
      "A Linux desktop you can watch live and take over, with several bots' screens on one computer.",
      "Shell commands and reading and writing files.",
      "Stopped computers keep their disk. Archived sandboxes are woken up when a bot needs them again.",
    ],
    limits: [
      "No terminal. Command output arrives when the command finishes, not as it runs.",
      "The first start installs the desktop, so it is slower than later starts.",
      "Linux only from Rakazo. No volumes, and no region choice beyond `DAYTONA_TARGET`.",
    ],
    setup: [
      "Set `SANDBOX_PROVIDER=daytona` and `DAYTONA_API_KEY`, or choose Daytona in Settings → Computer as an admin.",
      "`DAYTONA_API_URL`, `DAYTONA_TARGET` and `DAYTONA_SNAPSHOT` are optional.",
    ],
    faq: [
      {
        question: "Is Daytona open source?",
        answer:
          "Its repository was archived in 2026, and its README says core development moved to a private codebase. Use Daytona's hosted service with Rakazo; for a fully self-hosted setup, use Docker or Kubernetes.",
      },
      {
        question: "Daytona or E2B?",
        answer:
          "E2B adds a terminal, streamed output and pausing with resume. Daytona suits teams already on it.",
      },
    ],
    sources: [
      { label: "Daytona", href: "https://www.daytona.io" },
      { label: "Daytona on GitHub (archived)", href: "https://github.com/daytonaio/daytona" },
      PROVIDERS_DOC,
    ],
  },
  {
    slug: "novita",
    name: "Novita",
    title: "Novita Agent Sandbox for AI agents: run Rakazo bot computers on Novita",
    description:
      "Give each Rakazo bot a Linux desktop on Novita's Agent Sandbox. Paused computers keep their files, browser logins and running programs.",
    h1: "Run your AI agents' computers on Novita",
    intro: [
      "Novita's Agent Sandbox runs stateful sandboxes for AI agents. Rakazo can use it as the place where your bots' computers live.",
      "When a computer goes idle it pauses with its memory intact, so a bot comes back to the same open browser and running programs.",
    ],
    image: homepage(
      "novita",
      "Novita",
      "The Novita Agent Sandbox page, headed Runtime for AI agents to execute real-world tasks.",
    ),
    works: [
      "A Linux desktop you can watch live and take over, with several bots' screens on one computer.",
      "Shell commands with cancel, a terminal, and reading and writing files.",
      "Pause on idle and on stop, keeping files, browser profiles and running-process memory.",
      "If a pause can't be confirmed, the computer is set aside until you choose Recover or Reset, so it is never resumed silently.",
    ],
    limits: [
      "No region choice from Rakazo.",
      "Requires a one-time template build; there is no fallback to Novita's stock desktop.",
      "Paused storage is billed under Novita's own terms.",
    ],
    setup: [
      "Set `SANDBOX_PROVIDER=novita` and `NOVITA_API_KEY` on the API and worker, or choose Novita in Settings → Computer as an admin.",
      "Build the template once with `pnpm sandbox:novita-template`. `SANDBOX_TEMPLATE` picks a different one.",
    ],
    faq: [
      {
        question: "Does a paused Novita computer keep running programs?",
        answer:
          "Yes. Pausing keeps memory, so programs and browser sessions continue when the computer resumes.",
      },
    ],
    sources: [
      { label: "Novita Agent Sandbox", href: "https://novita.ai/sandbox" },
      { label: "Novita sandbox overview", href: "https://docs.novita.ai/guides/sandbox-overview" },
      PROVIDERS_DOC,
    ],
  },
  {
    slug: "railway",
    name: "Railway",
    title: "Railway for AI agents: run Rakazo and its bot computers on Railway",
    description:
      "Run Rakazo, its database and your bots' computers in one Railway account, from one template.",
    h1: "Run Rakazo and your agents' computers on Railway",
    intro: [
      "Railway hosts apps, databases and on-demand Linux sandboxes. With the Rakazo template, the app, Postgres and your bots' computers all run in one Railway account, with no separate sandbox provider.",
    ],
    image: homepage("railway", "Railway", "The Railway homepage, headed Ship software peacefully."),
    works: [
      "A Linux desktop you can watch live and take over, with several bots' screens and a browser.",
      "Shell commands and reading and writing files.",
      "Computers live in their own Railway environment, separate from the app.",
    ],
    limits: [
      "No pause. Stopping deletes the sandbox, and the next start restores the bot's saved workspace, so open programs and memory are lost.",
      "No terminal, and command output arrives when the command finishes.",
      "The desktop installs on first use, which can take a few minutes.",
      "On Railway's Trial and Free plans, the short idle timeout can delete a computer before its work is saved.",
    ],
    setup: [
      "Deploy the Rakazo template on Railway, or set `SANDBOX_PROVIDER=railway`, `RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID` on an existing deployment.",
      "`RAILWAY_SANDBOX_REGION` is optional.",
    ],
    faq: [
      {
        question: "Why choose Railway over E2B or Novita?",
        answer:
          "Everything runs in one account you already use. If your bots need to keep programs running between sessions, E2B or Novita pause instead of rebuilding.",
      },
    ],
    sources: [
      { label: "Railway", href: "https://railway.com" },
      { label: "Railway sandboxes", href: "https://docs.railway.com/sandboxes" },
      { label: "Rakazo Railway template", href: `${GITHUB_URL}/blob/main/infra/railway/README.md` },
      PROVIDERS_DOC,
    ],
  },
  {
    slug: "boat",
    name: "Boat",
    title: "Boat for AI agents: run Rakazo bot computers on Boat",
    description:
      "Give each Rakazo bot a Linux desktop on a Boat cloud VM, with its own Chrome profile and logins.",
    h1: "Run your AI agents' computers on Boat",
    intro: [
      "Boat runs cloud VMs for agents, with a desktop and browser. Rakazo can use it as the place where your bots' computers live.",
      "Each bot gets its own Chrome profile, so one bot's logins are never shared with another.",
    ],
    image: homepage(
      "boat",
      "Boat",
      "The Boat homepage, headed Most powerful and affordable cloud VMs for agents.",
    ),
    works: [
      "A Linux desktop you can watch live and take over, with several bots' screens on one computer.",
      "Shell commands and reading and writing files.",
      "A separate, persistent Chrome profile for each bot.",
      "Computers start from a prebuilt snapshot that Rakazo builds on its own the first time.",
    ],
    limits: [
      "No terminal.",
      "No region choice or custom image from Rakazo. Boat's regions are in the EU.",
      "Stopping keeps the disk, not running programs.",
    ],
    setup: [
      "Set `SANDBOX_PROVIDER=boat` and `BOAT_API_KEY`, or choose Boat in Settings → Computer as an admin. `BOAT_API_URL` is optional.",
      "No template step: the snapshot builds itself. `pnpm sandbox:boat-snapshot` builds it ahead of time.",
    ],
    faq: [
      {
        question: "Do Boat computers see my server's environment variables?",
        answer: "No. Rakazo always creates Boat sandboxes without the account's environment.",
      },
    ],
    sources: [{ label: "Boat", href: "https://boat.dev" }, PROVIDERS_DOC],
  },
  {
    slug: "wuying",
    name: "Wuying",
    title: "Wuying cloud computer for AI agents: let Rakazo bots use Alibaba Cloud desktops",
    description:
      "Let Rakazo bots work on a Windows cloud computer you already have in Alibaba Cloud Wuying (Elastic Desktop Service).",
    h1: "Let your AI agents use a Wuying cloud computer",
    intro: [
      "Wuying is Alibaba Cloud's cloud computer service, sold internationally as Elastic Desktop Service. Rakazo can let bots work on a Windows cloud computer you already run there.",
      "It suits teams on Alibaba Cloud and in mainland China, where other sandbox providers can be hard to reach. It is also the only provider Rakazo supports with a Windows desktop.",
    ],
    image: homepage(
      "wuying",
      "Alibaba Cloud Elastic Desktop Service",
      "The Alibaba Cloud Elastic Desktop Service page, headed Empower your workspace with secure, open, and affordable cloud computers.",
    ),
    works: [
      "PowerShell commands, files, screenshots, mouse and keyboard.",
      "A live screen you can watch and take over.",
      "Files stay on the desktop's own disk.",
      "People can set it up for their own account in Settings, not only admins.",
    ],
    limits: [
      "Everyone using that desktop shares one Windows account, its files and its signed-in apps. Use it for trusted teams.",
      "One screen at a time, no terminal, and no Private Computers.",
      "Each command can run for up to a minute.",
    ],
    setup: [
      "Choose Wuying in Settings → Computer, or set `SANDBOX_PROVIDER=wuying` with every value listed in the Wuying setup guide, including `WUYING_END_USER_ID`.",
      "The region defaults to `cn-hangzhou`.",
    ],
    faq: [
      {
        question: "Is this Alibaba Cloud AgentBay?",
        answer:
          "No. Rakazo uses a Wuying cloud computer you already have, not the AgentBay sandbox service.",
      },
    ],
    sources: [
      {
        label: "Alibaba Cloud Elastic Desktop Service",
        href: "https://www.alibabacloud.com/en/product/cloud-desktop",
      },
      { label: "无影云电脑", href: "https://www.aliyun.com/product/ecs/gws" },
      { label: "Rakazo, Wuying setup", href: `${GITHUB_URL}/blob/main/docs/wuying-computers.md` },
    ],
  },
  {
    slug: "docker",
    name: "Docker",
    title: "Run AI agents in Docker: self-hosted computers for Rakazo bots",
    description:
      "Rakazo gives each bot a Docker container with a desktop and browser on your own machine. No cloud account, no per-minute bill.",
    h1: "Run your AI agents' computers in Docker",
    intro: [
      "Docker is Rakazo's default. Each bot computer is a container on your own machine, with a desktop and browser you can watch. You don't need a cloud account or a sandbox provider.",
    ],
    image: homepage("docker", "Docker", "The Docker homepage, headed Trust Docker for the agents you don't."),
    works: [
      "A Linux desktop with Chromium you can watch live and take over, a terminal, commands and files.",
      "Files live on your disk and survive restarts.",
      "Containers drop all Linux capabilities and can't gain privileges, with default limits of 2 GB of memory and 2 CPUs.",
      "On Linux Docker Engine, restricted networking blocks your LAN, the Docker host and cloud metadata addresses.",
    ],
    limits: [
      "A hardened container shares your machine's kernel; it is not a separate VM.",
      "Restricted networking falls back to open on Docker Desktop for Mac and Windows, rootless Docker and nftables.",
      "There's no per-domain allowlist.",
    ],
    setup: [
      "The published Compose stack starts Docker computers by default. It needs `SANDBOX_SUPERVISOR_TOKEN` and access to the Docker socket.",
      "Docker computers can't be configured in Settings; they use the deployment's environment.",
    ],
    faq: [
      {
        question: "Is Docker enough isolation for an AI agent?",
        answer:
          "For a personal or team instance on a machine you control, a locked-down container is a common choice. If you need VM-level isolation, use a hosted provider or Kubernetes with gVisor or Kata.",
      },
      {
        question: "Is this the same as Docker Sandboxes?",
        answer:
          "No. Docker Sandboxes is Docker's own microVM product. Rakazo runs its computers as regular containers through a small supervisor.",
      },
    ],
    sources: [
      { label: "Docker", href: "https://www.docker.com" },
      {
        label: "Rakazo, Docker computers",
        href: `${GITHUB_URL}/blob/main/docs/self-host-docker-computers.md`,
      },
      PROVIDERS_DOC,
    ],
  },
  {
    slug: "kubernetes",
    name: "Kubernetes",
    title: "AI agent sandboxes on Kubernetes: one pod per Rakazo bot computer",
    description:
      "Run each Rakazo bot computer as a locked-down pod on your own cluster, with optional gVisor or Kata isolation.",
    h1: "Run your AI agents' computers on Kubernetes",
    intro: [
      "If you already run a cluster, Rakazo can create one pod per bot computer in a namespace you choose, on your own nodes and network.",
    ],
    image: homepage(
      "kubernetes",
      "Kubernetes",
      "The Kubernetes homepage, headed Production-Grade Container Orchestration.",
    ),
    works: [
      "A Linux desktop you can watch live and take over, a terminal, commands and files.",
      "Pods run without a service account token, with all capabilities dropped, no privilege escalation and the default seccomp profile.",
      "Set a runtime class such as gVisor or Kata for stronger isolation, if your cluster has one.",
      "Workspaces are saved by Rakazo; you can also keep each home folder on a persistent volume.",
    ],
    limits: [
      "You set up the Role, NetworkPolicy and runtime class yourself; Rakazo doesn't create them.",
      "Rakazo creates plain pods, not the Agent Sandbox custom resource.",
      "The API and worker normally run inside the cluster.",
    ],
    setup: [
      "Set `SANDBOX_PROVIDER=kubernetes` and the `KUBERNETES_SANDBOX_*` settings. The service account needs to create, read, delete and exec into pods in that namespace.",
    ],
    faq: [
      {
        question: "Can I use gVisor or Kata Containers?",
        answer:
          "Yes, if your cluster provides the runtime class. Rakazo sets it on each computer pod.",
      },
    ],
    sources: [
      { label: "Kubernetes", href: "https://kubernetes.io" },
      { label: "Kubernetes Agent Sandbox", href: "https://agent-sandbox.sigs.k8s.io" },
      PROVIDERS_DOC,
    ],
  },
  {
    slug: "your-computer",
    name: "Your computer",
    title: "Let an AI agent use your own computer",
    description:
      "With the Rakazo desktop app, bots can run commands and use apps on the Mac or PC the app runs on.",
    h1: "Let your AI agents use your own computer",
    intro: [
      "With the Rakazo desktop app, bots can work on the computer the app runs on, with your real files, apps and logins. There are two ways to turn it on, and they behave differently.",
      "Either way, this is your machine, not a sandbox. Only turn it on for bots you'd trust unattended.",
    ],
    image: {
      webp: "/graphics/chat/approval.png",
      width: 1200,
      height: 800,
      alt: "An approval card asking whether a demo bot may send an email, with allow once, always allow, and deny.",
      caption: "An approval card in Rakazo.",
    },
    works: [
      "Let bots use this computer, in Settings → General, works with Rakazo Cloud or any server. A bot asks before its first command in a space and before it first uses each app, in every approval mode, and only in your own chats.",
      "With it, bots can also see and use apps on screen on Mac and Windows. macOS asks for Accessibility and Screen Recording.",
      "Use this Mac (Use this computer on Windows and Linux) makes your computer the bot's computer on a local server the app runs. Bots run commands on it without asking, including in routines.",
    ],
    limits: [
      "Commands run as you, with your permissions. There is no isolation.",
      "With Let bots use this computer, commands, output and screenshots pass through the Rakazo server you're connected to. Your files stay on your computer.",
      "Use this Mac has no screen control. Screen control isn't available on Linux.",
      "The app has to stay open.",
    ],
    setup: [
      "Install the desktop app. With any server, turn on Let bots use this computer in Settings → General, and turn it off there to revoke access.",
      "On a local server started by the app, choose Use this Mac when it asks Where should bots run?, and use Revoke Local Computer Access in the app menu to undo it.",
    ],
    faq: [
      {
        question: "Is this safer than a sandbox?",
        answer:
          "No. A sandbox keeps a bot away from your files; this gives it your files on purpose. Use Docker or a hosted provider when you don't want that.",
      },
    ],
    sources: [
      { label: "Rakazo, desktop app", href: `${GITHUB_URL}/blob/main/docs/desktop-app.md` },
      {
        label: "Rakazo, use your own computer",
        href: `${GITHUB_URL}/blob/main/docs/computer.md#use-your-own-computer`,
      },
    ],
  },
];

export function sandboxPath(slug: string): string {
  return `${SANDBOXES_PATH}${slug}/`;
}

/** Markdown twin of a sandbox page, for agents and `.md` requests. */
export function sandboxMarkdown(sandbox: Sandbox): string {
  return [
    `# ${sandbox.h1}`,
    "",
    ...sandbox.intro.flatMap((paragraph) => [paragraph, ""]),
    `Updated ${SANDBOXES_UPDATED}.`,
    "",
    "## What your bots get",
    "",
    ...sandbox.works.map((item) => `- ${item}`),
    "",
    "## Limits",
    "",
    ...sandbox.limits.map((item) => `- ${item}`),
    "",
    "## Set it up",
    "",
    ...sandbox.setup.flatMap((paragraph) => [paragraph, ""]),
    `[Computer providers guide](${COMPUTER_PROVIDERS_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...sandbox.faq.flatMap((item) => [`### ${item.question}`, "", item.answer, ""]),
    "## Other places to run bot computers",
    "",
    ...SANDBOXES.filter((other) => other.slug !== sandbox.slug).map(
      (other) => `- [${other.name}](${sandboxPath(other.slug)})`,
    ),
    "",
    "## Sources",
    "",
    ...sandbox.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ].join("\n");
}
