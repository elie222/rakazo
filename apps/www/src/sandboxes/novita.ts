import { PROVIDERS_DOC, RUNTIME_DOC } from "./shared";
import type { Sandbox } from "./types";

export const novita: Sandbox = {
  slug: "novita",
  name: "Novita",
  runsOn: "Hosted Linux sandbox",
  keeps: "Files, browser logins and running programs",
  bestFor: "Bots that pick up where they left off",
  title: "Novita Agent Sandbox for AI agents: give each bot a computer that pauses",
  description:
    "Run your AI agents' computers on Novita's Agent Sandbox with Rakazo. Idle computers pause with their memory, so a bot comes back to the same open browser and programs.",
  h1: "Run your AI agents' computers on Novita",
  intro: [
    "Novita's Agent Sandbox gives AI agents their own Linux machines in the cloud, started and stopped through an API. Novita AI also sells model APIs and GPUs, and its sandbox works with the E2B SDK.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each bot gets its own computer with a desktop, a browser, a terminal and files. You can watch its screen and take over at any time. When you self-host Rakazo, Novita can be where those computers live. Its main strength is the pause: an idle computer is frozen with its memory intact, so a bot comes back to the same open tabs and running programs.",
  ],
  scene: {
    bot: "Talent Scout",
    color: "#3B82F6",
    where: "Computer on Novita",
    ask: "pick the infra applicants back up where you stopped yesterday",
    reply: "same tab is still open on applicant 34. carrying on from there.",
    task: "Back in Ashby where it paused.",
    screen: {
      host: "app.ashbyhq.com",
      title: "Infra applicants",
      lines: ["Resumed at applicant 34", "61 read · 9 shortlisted", "3 intros held"],
    },
  },
  sections: [
    {
      heading: "What is Novita?",
      paragraphs: [
        "[Novita AI](https://novita.ai) is a cloud platform for AI developers. Alongside model APIs and GPU instances, it runs the [Agent Sandbox](https://novita.ai/sandbox): isolated Linux machines that an agent can start in seconds, run commands in, and pause when it is done. A paused sandbox keeps its disk and memory, and resumes as the same machine.",
        "Novita offers a desktop image for these sandboxes, which is what Rakazo builds on. You need a Novita account and an API key. Usage is billed by Novita, not by Rakazo.",
      ],
      image: true,
    },
    {
      heading: "What a bot can do on a Novita computer",
      paragraphs: [
        "Rakazo turns each Novita sandbox into a full bot computer. A bot works there the same way it does on any other Linux provider, and you see it in the computer panel next to the chat.",
      ],
      bullets: [
        "Use a Linux desktop and browser, with each bot on its own screen when several bots share one computer.",
        "Run shell commands, which you or the bot can cancel, and read and write files.",
        "You can open a terminal on the computer yourself, watch the screen live, and take over when a bot asks for help with a login or a captcha.",
        "When the computer sits idle or is stopped, Rakazo pauses it instead of deleting it. Files, browser profiles and the memory of running programs are kept, and the next use resumes the same computer.",
      ],
    },
    {
      heading: "When to choose Novita",
      paragraphs: [
        "Choose Novita when bots run long, multi-step work in a browser and you want them to come back to exactly where they were, not to a fresh desktop rebuilt from saved files. It also fits if you already use Novita for models or GPUs and want one fewer account.",
        "[E2B](/sandboxes/e2b/) pauses idle computers in a similar way and is what Rakazo's own live computer tests run on. [Boat](/sandboxes/boat/) is what Rakazo Cloud uses, with a separate Chrome profile for each bot, but it keeps the disk, not running programs. [Railway](/sandboxes/railway/) rebuilds a computer from saved files after every stop. If you don't want a cloud account at all, [Docker](/sandboxes/docker/) runs computers on your own server. The [sandbox comparison](/sandboxes/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "It needs a one-time template build in your Novita account. Rakazo does not fall back to Novita's larger stock desktop.",
        "You can't pick a region from Rakazo.",
        "Paused computers still use storage, which Novita bills and retains on its own terms.",
        "If Rakazo can't confirm that a command stopped, it pauses the computer and sets it aside. It stays paused until you choose Recover or Reset, so it is never resumed silently with a stuck command inside.",
        "Novita computers are for self-hosted Rakazo. Rakazo Cloud runs its computers on Boat.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "This is done once by the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/) deployment. Everyone else on that deployment then gets Novita computers without doing anything.",
      ],
      steps: [
        "Create an API key in your Novita account.",
        "Build the computer template in that same account: `NOVITA_API_KEY=<your-key> pnpm sandbox:novita-template`. It creates a template called `rakazo-computer` with 2 vCPU and 4 GB of memory, based on Novita's desktop image.",
        "Set `SANDBOX_PROVIDER=novita` and `NOVITA_API_KEY` on both the API and the worker, then restart them. Or, as an admin, open Settings → Computer and choose Novita under New computers run on.",
        "Open a bot's computer to check that it starts and shows a desktop.",
      ],
    },
    {
      heading: "Using your own template",
      paragraphs: [
        "To use a different desktop template, set `SANDBOX_TEMPLATE` to its name both when you build it and on the API and worker. Rebuild after the template definition changes. Computers that already exist keep the template and resources they started with. The [computer providers guide](/docs/self-host-sandbox-providers/) has the full details.",
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/novita.webp",
    avif: "/graphics/sandboxes/novita.avif",
    width: 1280,
    height: 800,
    alt: "The Novita Agent Sandbox page, headed Runtime for AI agents to execute real-world tasks.",
    caption: "Novita homepage, November 4, 2026.",
  },
  faq: [
    {
      question: "Does a paused Novita sandbox keep running programs?",
      answer:
        "Yes. Pausing keeps the computer's memory as well as its disk, so open browser tabs and running programs carry on when Rakazo resumes it.",
    },
    {
      question: "Is Novita's sandbox compatible with E2B?",
      answer:
        "Novita's sandbox works with the E2B SDK. In Rakazo they are separate providers with their own settings, so you choose [Novita](/sandboxes/novita/) or [E2B](/sandboxes/e2b/) with `SANDBOX_PROVIDER`.",
    },
    {
      question: "Why does Rakazo need its own Novita template?",
      answer:
        "The `rakazo-computer` template sizes the desktop at 2 vCPU and 4 GB instead of Novita's larger stock desktop. Rakazo requires it and won't start computers without it, so build it once with `pnpm sandbox:novita-template`.",
    },
    {
      question: "Can I use Novita on Rakazo Cloud?",
      answer:
        "No. Rakazo Cloud runs its bot computers on [Boat](/sandboxes/boat/). Novita is an option when you [self-host Rakazo](/self-hosted-ai-agent/).",
    },
  ],
  sources: [
    { label: "Novita Agent Sandbox", href: "https://novita.ai/sandbox" },
    { label: "Novita sandbox overview", href: "https://docs.novita.ai/guides/sandbox-overview" },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
