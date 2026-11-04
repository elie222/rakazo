import { GITHUB_URL } from "../site";
import { PROVIDERS_DOC, RUNTIME_DOC } from "./shared";
import type { Sandbox } from "./types";

const RAILWAY_TEMPLATE_DOC = `${GITHUB_URL}/blob/main/infra/railway/README.md`;

export const railway: Sandbox = {
  slug: "railway",
  name: "Railway",
  runsOn: "Your Railway account",
  keeps: "The workspace Rakazo saved",
  bestFor: "Running everything in one Railway account",
  title: "Railway sandboxes for AI agents: host Rakazo and its bot computers in one account",
  description:
    "Deploy Rakazo on Railway from one template: the app, Postgres and your AI agents' sandbox computers all run in your Railway account, with no separate sandbox provider.",
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
    task: "Reproducing reports in Sentry.",
    screen: {
      host: "sentry.io",
      title: "Auth loop: P1",
      lines: ["6 new reports", "4 reproduced", "Stale session token"],
    },
  },
  sections: [
    {
      heading: "What is Railway?",
      paragraphs: [
        "[Railway](https://railway.com) deploys services from a repository or image and gives them HTTPS domains, volumes and managed databases. Usage is billed to your Railway workspace. Its [sandboxes](https://docs.railway.com/sandboxes) are separate machines created on demand, which Rakazo uses as bot computers.",
        "Because the app and the computers live in the same account, you manage one set of credentials and one bill for hosting. Your model provider is still billed separately.",
      ],
      image: true,
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
        "On Railway's Trial and Free plans, the short idle timeout can delete a computer before its work is saved.",
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
    { label: "Railway sandboxes", href: "https://docs.railway.com/sandboxes" },
    { label: "Rakazo Railway template", href: RAILWAY_TEMPLATE_DOC },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
