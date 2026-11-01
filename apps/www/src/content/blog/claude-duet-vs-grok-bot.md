---
title: "Claude Duet vs Grok Bot, and an open source alternative"
description: "Anthropic released Claude Duet on October 21, 2026. How it compares with xAI's Grok Bot, and with Rakazo, the open source option you run yourself."
published: "2026-10-24"
updated: "2026-10-24"
author: "Elie Steinbock"
category: "comparisons"
tldr: "Claude Duet is one proactive agent in one thread: it briefs you each morning, watches your inbox and calendar, and asks before it sends, pays, signs, or deletes. Grok Bot is a set of named bots with routines on a shared cloud computer. Both are hosted and pick the model for you. Rakazo is the open source version you run, with the model you choose, including your Claude subscription."
sources:
  - label: "Anthropic, Introducing Claude Duet (October 21, 2026)"
    href: "https://claude.com/resources/articles/claude-duet"
  - label: "Claude Duet"
    href: "https://claude.com/product/claude-duet"
  - label: "Claude Help Center, Get started with Claude Duet"
    href: "https://support.claude.com/en/articles/17631495"
  - label: "Anthropic, Claude Duet: Safety, Privacy, and Security (October 23, 2026)"
    href: "https://claude.com/resources/articles/claude-duet-safety-privacy-and-security"
  - label: "Claude pricing"
    href: "https://claude.com/pricing"
  - label: "Grok Bot overview"
    href: "https://docs.x.ai/grok-bot/overview"
  - label: "Grok Bot FAQ"
    href: "https://docs.x.ai/grok-bot/faq"
  - label: "xAI pricing"
    href: "https://x.ai/pricing"
  - label: "Rakazo source"
    href: "https://github.com/elie222/rakazo"
related:
  - href: "/claude-duet-alternative/"
    title: "Open source Claude Duet alternative"
    description: "The full Rakazo and Claude Duet comparison table."
  - href: "/grok-bot-alternative/"
    title: "Grok Bot alternatives (open source and hosted)"
    description: "A list of open source and hosted Grok Bot alternatives."
  - href: "/alternatives/"
    title: "Best personal AI agents in 2026"
    description: "Every hosted and open source agent we compare, in one table."
  - href: "/blog/self-host-an-ai-agent/"
    title: "How to self-host an AI agent"
    description: "The published-image install for Rakazo."
faq:
  - question: "Is Claude Duet available to everyone?"
    answer: "No. It is a research preview for Claude Pro and Max subscribers in the US, and invitations go out from a waitlist. Team and Enterprise plans are not included yet."
  - question: "Can I pick the model in Claude Duet or Grok Bot?"
    answer: "No. Duet runs on Claude Opus 5.5, and the help center says you cannot choose a model. The Grok Bot docs do not describe connecting your own provider. Rakazo lets each bot use a different model, including Claude through your Pro or Max sign-in."
  - question: "Can I self-host Claude Duet or Grok Bot?"
    answer: "Neither product's pages describe a self-hosted install. Duet runs on a cloud computer Anthropic operates. Grok Bot uses a cloud computer on your account, with an optional local computer for approved commands. Rakazo is Apache-2.0 and runs on hardware you control."
  - question: "Where do these details come from?"
    answer: "Anthropic's Duet announcement, product page, help center article, and safety post, xAI's Grok Bot docs and pricing page, and this project's source. They were read on October 24, 2026. Duet is a research preview, so check those pages before you rely on a detail."
comparison:
  caption: "Public descriptions, read on October 24, 2026."
  columns:
    - "Topic"
    - "Claude Duet"
    - "Grok Bot"
    - "Rakazo"
  rows:
    - topic: "Shape"
      cells:
        - "One agent in one ongoing thread"
        - "Named bots with routines"
        - "Named bots with routines, in a chat"
    - topic: "Who runs it"
      cells:
        - "Anthropic, on a cloud computer"
        - "xAI, on a shared cloud computer"
        - "You, or Rakazo Cloud in beta"
    - topic: "Model"
      cells:
        - "Claude Opus 5.5. No choice."
        - "Included. No own provider in the docs."
        - "Your choice per bot, including Claude Pro/Max"
    - topic: "Price"
      cells:
        - "Pro at $20 a month, Max from $100"
        - "Paid Cursor plans, SuperGrok at $30 a month"
        - "No seat fee. You pay the model and computer."
    - topic: "Availability"
      cells:
        - "US only, from a waitlist"
        - "Paid plans listed on the pricing page"
        - "Self-host now. Cloud in beta."
    - topic: "Source"
      cells:
        - "Hosted only"
        - "Hosted only"
        - "Apache-2.0"
---

Anthropic released Claude Duet on October 21, 2026, as a research preview. It joins Meta's Muse, OpenAI's Dots, Hark Pro, and xAI's Grok Bot as a hosted personal agent. All of them take work off your hands after you close the app. They differ in how many agents you get, who runs the computer, and whether you can pick the model.

## What Claude Duet is

Duet is a standalone app for iOS and Android, also on the web at claude.ai. You message it the way you would message a person, by text or voice, in one ongoing thread. A Tasks tab shows work in progress, and a Make tab holds files from larger jobs.

Each morning it reviews your email and calendar, sorts what matters, and can start on first steps such as drafting replies. After that it checks your connected accounts at intervals and stays quiet until something needs you. The announcement says it checks every few hours, because checking constantly would use up plan limits much faster. The help center does not give a number, and says urgent items can arrive between checks.

Duet works on its own cloud computer, a virtual machine with a browser, so it keeps going after you close the app. You cannot watch or take over that browser. It connects through Claude's connectors and plugins: the help center names Gmail, Google Calendar, Google Drive, Slack, QuickBooks, HubSpot, Docusign, and Calendly. Microsoft 365 is not available yet. Purchases go through Link by Stripe or Shop Pay with one-time virtual cards.

It asks before it sends a message, makes a payment, signs a document, or deletes anything. If you are not around, it finishes the rest and brings the approval back later. Trading securities, moving money between accounts, and accessing someone else's account are blocked even if you approve. Anthropic says Duet never sees your passwords, cookies, or app tokens. A proxy outside the agent's machine adds them to each request.

Duet runs on Claude Opus 5.5, and you cannot choose a model. It is included with Claude Pro and Max in the US, from a waitlist, and its work counts against the plan's usage limits at the same rate as chats. Anthropic is direct about the rough edges. It may misread a thread, misjudge what is urgent, or miss something between check-ins. Personal errands such as booking tickets are less developed than work tasks.

## How it compares with Grok Bot

Grok Bot is xAI's hosted product for named bots that can use a computer, keep routines, and pause for approval. Duet is one agent. Grok Bot is a roster. That is the main difference in shape.

The computers are different too. Duet's computer belongs to the agent and runs on Anthropic's cloud. Grok Bot's docs describe one cloud computer on your account, shared by every bot on that account, including files and logins. An optional local computer can run approved commands on the machine in front of you.

Duet is proactive by default: the morning brief and check-ins are the product. Grok Bot leans on routines you set up for each bot.

Price follows a plan in both cases. Duet comes with Claude Pro at $20 a month and Max from $100. Grok Bot comes with paid Cursor plans and SuperGrok, listed at $30 a month. Neither lets you bring your own model provider, and neither describes running the service yourself.

## Where Rakazo fits

Rakazo is the open source version of this shape. It is Apache-2.0, and it is in beta. You run it with the published Docker images or the desktop app, or use Rakazo Cloud, in beta. The clients are the web app, the Electron desktop app, and the Expo mobile app.

Like Grok Bot, it is just chat once it is running. You create named bots and manage each one from its conversation. Each bot keeps memory, routines, and history. Routines are readable Markdown and can run on a schedule, so a morning brief is a routine you write, not a fixed feature. A bot can pause for approval at a boundary you set, and actions are recorded in an audit log.

The model is yours. You can sign in with Claude Pro or Max, ChatGPT Plus or Pro, or SuperGrok, or bring a key for OpenAI, Anthropic, Google, OpenRouter, or a local server such as Ollama. Each bot can use a different model. So if you already pay for Claude, Rakazo can use that subscription on a computer you run.

The computer is yours too. Local Docker is the default. E2B, Daytona, CreateOS, and Boat are optional. Team computers are shared, and private computers are isolated. Connector credentials are encrypted on your server and are never returned by the API.

## Which to choose

Choose Claude Duet when you pay for Claude Pro or Max, live in the US, and want one agent that watches your inbox and calendar without any setup. Accept that Anthropic runs the computer, picks the model, and that this is a preview.

Choose Grok Bot when you already pay for Cursor or SuperGrok and want several named bots on a computer xAI hosts.

Choose Rakazo when the agents should run on hardware you control, with the model you pick, and you want more than one bot. The cost is the install: Docker or the desktop app, then an account and a model. [How to self-host an AI agent](/blog/self-host-an-ai-agent/) walks through it.

This page compares public descriptions. It does not measure how often any of them gets a task right. Duet especially will change during the preview, so check the linked sources before you rely on a detail.
