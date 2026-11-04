import { PROVIDERS_DOC, RUNTIME_DOC, homepage } from "./shared";
import type { Sandbox } from "./types";

export const daytona: Sandbox = {
  slug: "daytona",
  name: "Daytona",
  runsOn: "Hosted Linux sandbox",
  keeps: "Its disk",
  bestFor: "Teams already on Daytona",
  title: "Daytona AI agent sandbox: desktops for Rakazo bots on Daytona",
  description:
    "What Daytona is, and how Rakazo runs AI agents in Daytona sandboxes: a Linux desktop, browser and terminal you can watch and take over. Setup, limits and FAQ.",
  h1: "Daytona for AI agents: run your bots' computers on Daytona",
  intro: [
    "[Daytona](https://www.daytona.io) is a hosted service for running AI-generated code in sandboxes. Each sandbox is an isolated Linux machine with its own disk, which can be stopped, archived and started again later.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. If your team already uses Daytona, a self-hosted Rakazo can put those computers there. Daytona supplies the sandbox. Rakazo installs the desktop, gives each bot its own screen, saves its work, and decides when the sandbox stops.",
  ],
  scene: {
    bot: "Talent Scout",
    color: "#3B82F6",
    where: "Computer on Daytona",
    ask: "read the infra applicants and shortlist anyone who has run their own cluster",
    reply: "on it. reading every profile and repo. intros held for you.",
    task: "Reading applicants in Ashby.",
    screen: {
      host: "app.ashbyhq.com",
      title: "Infra applicants",
      lines: ["61 read", "9 shortlisted: ran their own cluster", "3 intros held"],
    },
  },
  sections: [
    {
      heading: "What is Daytona?",
      paragraphs: [
        "[Daytona](https://www.daytona.io) gives developers and AI agents sandboxes they can create through an API. Sandboxes start from snapshots, can run in different targets, and keep their disk when they stop. A sandbox that has been archived is moved to cheaper storage and copied back when it wakes.",
        "Daytona started as an open source project. Its public GitHub repository was archived in 2026, and its README says core development moved to a private codebase, so treat it as a hosted service rather than something you run yourself.",
      ],
      image: true,
    },
    {
      heading: "What your bots can do on a Daytona computer",
      paragraphs: [
        "On Daytona, each Rakazo bot works on a real Linux desktop. You see its screen in the chat and can take over the mouse and keyboard at any time.",
      ],
      bullets: [
        "Browse the web in Chromium, with its own screen and browser profile. Signed-in sessions stay between runs.",
        "Run shell commands, read and write files, and open a terminal you can type in yourself.",
        "Share one computer. Bots in a workspace share a team computer by default, and each one gets its own screen on it.",
        "Keep their files. A stopped computer keeps its disk, and Rakazo also keeps its own copy of each bot's workspace, so a lost sandbox is replaced from the saved work.",
      ],
    },
    {
      heading: "When to choose Daytona",
      paragraphs: [
        "Choose Daytona when your team already has a Daytona account, billing or targets you want to reuse. Rakazo turns off Daytona's own auto-stop and auto-delete and stops computers with its own idle timer, so a computer doesn't disappear while a bot still needs it.",
        "If you are picking a hosted provider from scratch, [E2B](/sandboxes/e2b/) starts from a ready desktop template and pauses idle computers, and [Boat](/sandboxes/boat/) is what Rakazo Cloud runs on. [Novita](/sandboxes/novita/) keeps open programs in memory when it pauses. To avoid a cloud account, use [Docker](/sandboxes/docker/) or [Kubernetes](/sandboxes/kubernetes/). The [sandbox comparison](/sandboxes/) has them all side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "The first start of a new computer installs the desktop, so it is slower than later starts.",
        "Waking an archived sandbox copies its disk back first and can take up to 10 minutes.",
        "A bot sees a command's output when the command finishes, not while it runs.",
        "Rakazo runs Linux computers only on Daytona, without volumes, and the only location choice is `DAYTONA_TARGET`.",
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
        "Optionally set `DAYTONA_SNAPSHOT` in the environment to start new computers from a Daytona snapshot of your own. Leave it unset to use Daytona's default.",
        "Open a bot's computer in Rakazo and wait for the first start to install the desktop.",
      ],
    },
  ],
  image: homepage("daytona", "Daytona", "The Daytona homepage, headed Run AI code."),
  faq: [
    {
      question: "Is Daytona open source?",
      answer:
        "Not anymore in practice. Its GitHub repository was archived in 2026, and its README says core development moved to a private codebase. Rakazo uses Daytona's hosted service. For a fully self-hosted setup, use [Docker](/sandboxes/docker/) or [Kubernetes](/sandboxes/kubernetes/).",
    },
    {
      question: "Can AI agents use a browser in Daytona?",
      answer:
        "Yes. Rakazo installs a Linux desktop with Chromium in each Daytona sandbox. Every bot gets its own screen and browser profile, and you can watch it or take over.",
    },
    {
      question: "Daytona vs E2B for AI agents?",
      answer:
        "Both run Rakazo bot computers with a desktop, terminal and files. [E2B](/sandboxes/e2b/) starts from a desktop template and pauses idle computers, and it is open source. On Daytona the first start installs the desktop, and waking an archived computer can take several minutes. Pick Daytona mainly if your team already uses it.",
    },
    {
      question: "Does Daytona delete idle sandboxes?",
      answer:
        "Not the ones Rakazo creates. Rakazo turns off Daytona's auto-stop and auto-delete, and its own idle timer stops the computer, which keeps its disk.",
    },
  ],
  sources: [
    { label: "Daytona", href: "https://www.daytona.io" },
    { label: "Daytona on GitHub (archived)", href: "https://github.com/daytonaio/daytona" },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
