import { GITHUB_URL } from "../site";
import {
  BOAT_RAKAZO,
  E2B_PRO_FEE,
  MAC_MINI,
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  RATES,
  WORKDAY_HOURS,
  aboutUsd,
  boatMonthly,
  macMiniMonthly,
  monthly,
  usd,
} from "./shared";
import type { Sandbox } from "./types";

export const yourComputer: Sandbox = {
  slug: "your-computer",
  name: "Your computer",
  runsOn: "Your Mac or PC, no isolation",
  keeps: "Everything; it's your machine",
  bestFor: "Bots that need your real apps and logins",
  title: "Let an AI agent use your computer: Rakazo bots on your Mac or PC",
  description:
    "How the Rakazo desktop app lets AI agents run commands and use apps on your own Mac or PC, when they ask first, what they can reach, what it costs compared with a cloud sandbox, and how to turn it off.",
  h1: "Let AI agents use your own computer",
  intro: [
    "Most of the time an AI agent should work on a computer of its own, away from your files. Sometimes the work is on your machine: a document open in a desktop app, a folder only you have, a program you can't install anywhere else. For that, you can let a bot use your actual Mac or PC, with your files, apps and logins.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. The Rakazo [desktop app](/download/) for Mac, Windows and Linux can also open the computer it runs on to your bots. There are two ways to do that, and they behave quite differently.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Your Mac",
    ask: "the offsite agenda is open in textedit, can you tidy it up?",
    reply: "sure. i'll ask before i use textedit on your mac.",
    computer: {
      task: "Tidying the agenda in TextEdit.",
      screen: {
        host: "TextEdit",
        title: "Offsite agenda.rtf",
        lines: ["Day 1: arrivals and dinner", "Day 2: planning from 9am", "Harbor House held"],
      },
    },
  },
  sections: [
    {
      heading: "Two ways to let bots use your computer",
      paragraphs: [
        "Let bots use this computer works when the desktop app is connected to Rakazo Cloud or another Rakazo server. The app's own local server uses Use this Mac instead. The bot keeps its own computer and gets your computer as an extra place to work. It asks you before its first command in a space and before it first uses each app, in every approval mode, and you answer Allow in this space or Deny.",
        "Use this Mac (Use this computer on Windows and Linux) is for when the desktop app runs Rakazo itself on your machine. Your computer then replaces the bot's computer entirely, and bots run commands on it without asking.",
      ],
      image: true,
    },
    {
      heading: "What a bot can do on your computer",
      paragraphs: [
        "In both modes, commands run as your user account, with your permissions. A bot can:",
      ],
      bullets: [
        "Run commands in a shell, so it can read and change your files, use command-line tools you've installed and launch apps.",
        "With Let bots use this computer on a Mac or Windows PC, see and use apps on your screen: take screenshots, click and type. Each app needs its own approval.",
        "Work with the apps and files you already have, without copying anything to a separate computer first.",
      ],
    },
    {
      heading: "When to choose your own computer",
      paragraphs: [
        "Choose it when the work really lives on your machine and you are there to approve it. For anything you'd leave running overnight or hand to a team, a separate computer is safer: [Docker](/sandboxes/docker/) runs bot computers on your own server, and hosted sandboxes such as [Boat](/sandboxes/boat/), which Rakazo Cloud uses, or [E2B](/sandboxes/e2b/) keep them in the cloud. With those, a mistake stays on the bot's computer and you can reset it. The [sandbox comparison](/sandboxes/) covers every option.",
      ],
    },
    {
      heading: "What it costs",
      paragraphs: [
        "Using your own computer adds no sandbox bill. With Use this Mac, the desktop app runs a free, self-hosted Rakazo in Docker on your machine, and bots work on your computer instead of a separate one, so you pay only your model provider. With Let bots use this computer, you pay for the Rakazo server you're connected to as usual, and the bot keeps its own computer there as well.",
        "The hidden cost is that the machine has to stay on and the app open. An always-on Mac mini draws about 4 W idle and up to about 65 W under full load, according to Apple.",
      ],
      table: {
        caption: "Your own computer next to a hosted sandbox, per month",
        columns: ["Option", "Isolation", "4 hours a workday", "Around the clock"],
        rows: [
          {
            topic: "A Mac mini you already own",
            cells: [
              "None, by design",
              `Under $${Math.ceil(macMiniMonthly(WORKDAY_HOURS))} of electricity`,
              `A${aboutUsd(macMiniMonthly(MONTH_HOURS)).slice(1)} at ${MAC_MINI.watts} W average and $${MAC_MINI.kwh.toFixed(2)} per kWh`,
            ],
          },
          { topic: "[Docker](/sandboxes/docker/) on that same Mac", cells: ["Container", "Same electricity", "Same electricity"] },
          {
            topic: "[E2B](/sandboxes/e2b/), 2 vCPU / 4 GB",
            cells: [
              "microVM",
              usd(monthly(RATES.e2b, WORKDAY_HOURS)),
              `${usd(monthly(RATES.e2b, MONTH_HOURS))}, or ${usd(monthly(RATES.e2b, MONTH_HOURS) + E2B_PRO_FEE)} with Pro for 24-hour sessions`,
            ],
          },
          {
            topic: `[Boat](/sandboxes/boat/), ${BOAT_RAKAZO.vcpus} vCPU / ${BOAT_RAKAZO.gb} GB`,
            cells: ["VM", `${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))} minimum`, usd(boatMonthly(BOAT_RAKAZO.hour, MONTH_HOURS))],
          },
        ],
        note: `${PRICES_NOTE} Electricity is an estimate; your rate and load will differ.`,
      },
    },
    {
      heading: "Limits and security",
      paragraphs: [
        "This is not a sandbox. There is no isolation between a bot and your account, so only allow bots you'd trust to work on your computer unattended.",
      ],
      bullets: [
        "With Let bots use this computer, a bot can reach your computer only in your own chats with your own bots. Routines, webhooks, chat-app channels and other people's messages can't use it.",
        "With Let bots use this computer, commands, their output and screenshots pass through the Rakazo server you're connected to. Your files stay on your computer unless a bot reads them.",
        "Screen control works on Mac and Windows. On a Mac it needs Accessibility and Screen Recording permission in System Settings. On Linux, bots can run commands but not control the screen.",
        "With Use this Mac, bots run commands without asking, including in routines. Using apps on screen still asks per app, and only in your own chats. Don't choose it for a server other people use.",
        "The desktop app has to stay open for bots to reach your computer.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone with the desktop app can do this; no server admin is needed. Install it from the [download page](/download/), then pick the mode that matches how you use Rakazo. The [desktop app guide](/docs/desktop-app/) covers both.",
      ],
      steps: [
        "To use Let bots use this computer, sign in to Rakazo Cloud or another server in the desktop app, open Settings → General, and turn on Let bots use this computer under Computers. Confirm when the app asks Allow bots to use this computer?",
        "On a Mac, allow Rakazo in System Settings → Privacy & Security → Accessibility and Screen Recording if you want bots to use apps on screen, then reopen the app.",
        "Ask a bot to do something on your computer, and choose Allow in this space when it asks.",
        "To use Use this Mac instead, choose This computer when the app asks which server to use. It runs Rakazo locally in Docker. When it asks Where should bots run?, choose Use this Mac.",
        "To stop, turn off Let bots use this computer in Settings, or choose Revoke Local Computer Access in the app menu for Use this Mac.",
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/your-computer.webp",
    avif: "/graphics/sandboxes/your-computer.avif",
    width: 1280,
    height: 720,
    alt: "A chat where the user asks a bot to look at TextEdit on their computer, and the bot asks: Use TextEdit on your computer? Allow in this space, or Deny.",
    caption: "A bot asks before it uses an app on your computer.",
  },
  faq: [
    {
      question: "Can an AI agent control my Mac?",
      answer:
        "Yes, with the Rakazo desktop app and Let bots use this computer turned on. After you grant Accessibility and Screen Recording permission, a bot can see and use apps on your screen, and it asks before it first uses each app in a space.",
    },
    {
      question: "Is it safe to let an AI agent use my computer?",
      answer:
        "It's as safe as the bot you allow. Commands run as you, with no sandbox, so a bot can read and change anything your account can. Keep it to bots you trust, and use a [Docker](/sandboxes/docker/) or hosted computer for everything else.",
    },
    {
      question: "Does it work on Windows and Linux?",
      answer:
        "Commands work on Mac, Windows and Linux. Screen control works on Mac and Windows only.",
    },
    {
      question: "Can a routine use my computer while I'm away?",
      answer:
        "Not with Let bots use this computer, which only works in your own chats. With Use this Mac, routines do use your computer, as long as the desktop app is open.",
    },
    {
      question: "How do I turn it off?",
      answer:
        "Turn off Let bots use this computer in Settings → General, or choose Revoke Local Computer Access in the app menu if you use Use this Mac. Let bots use this computer also ends when you sign out of that account.",
    },
  ],
  sources: [
    { label: "Rakazo, desktop app", href: `${GITHUB_URL}/blob/main/docs/desktop-app.md` },
    {
      label: "Rakazo, use your own computer",
      href: `${GITHUB_URL}/blob/main/docs/computer.md#use-your-own-computer`,
    },
    { label: "Rakazo, approvals", href: `${GITHUB_URL}/blob/main/docs/approvals.md` },
    { label: "Apple, Mac mini power consumption", href: "https://support.apple.com/en-us/103253" },
    PRICING.e2b,
    PRICING.boat,
  ],
};
