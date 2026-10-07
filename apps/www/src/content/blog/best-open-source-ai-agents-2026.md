---
title: "Best open source AI agents in 2026"
description: "A look at open source agents you can run yourself in 2026, split into apps and libraries. There is no single best, and this is not a benchmark."
published: "2026-10-07"
updated: "2026-10-07"
author: "Elie Steinbock"
category: "roundups"
tldr: "There is no single best open source agent. Rakazo, OpenClaw, Hermes Agent, OpenHands, and Goose are projects you can run. LangGraph and CrewAI are libraries for building your own. Dify's license is a modified Apache-2.0 with extra conditions. Pick the shape, then read that project's license."
sources:
  - label: "Rakazo source"
    href: "https://github.com/elie222/rakazo"
  - label: "OpenClaw"
    href: "https://docs.openclaw.ai/"
  - label: "Hermes Agent"
    href: "https://hermes-agent.nousresearch.com/"
  - label: "OpenHands Agent Canvas"
    href: "https://github.com/OpenHands/OpenHands"
  - label: "goose"
    href: "https://github.com/aaif-goose/goose"
  - label: "LangGraph"
    href: "https://github.com/langchain-ai/langgraph"
  - label: "CrewAI"
    href: "https://github.com/crewAIInc/crewAI"
  - label: "Dify license"
    href: "https://github.com/langgenius/dify/blob/main/LICENSE"
related:
  - href: "/blog/openclaw-vs-hermes-vs-rakazo/"
    title: "OpenClaw vs Hermes Agent vs Rakazo"
    description: "Which of those three is simplest to run."
  - href: "/alternatives/"
    title: "Open source alternatives"
    description: "Comparisons with hosted assistants as well as open source ones."
  - href: "/self-hosted-ai-agent/"
    title: "Self-hosted AI agent"
    description: "How to run Rakazo from published images."
  - href: "/openclaw-alternative/"
    title: "Open source OpenClaw alternative"
    description: "Rakazo and OpenClaw in more detail."
  - href: "/hermes-alternative/"
    title: "Open source Hermes alternative"
    description: "Rakazo and Hermes Agent in more detail."
faq:
  - question: "Is this a ranking?"
    answer: "No. The title names the question people ask. The body says there is not a single best agent. Nothing here is sorted by stars, downloads, or a benchmark."
  - question: "Which of these is a chat app?"
    answer: "Rakazo is a web, desktop, and mobile chat app. OpenClaw is a gateway you message from other chat apps. Hermes Agent has a desktop app and a terminal UI. Goose has a desktop app, a CLI, and an API. OpenHands Agent Canvas is a developer control center. LangGraph and CrewAI are libraries."
  - question: "Are they all Apache-2.0?"
    answer: "No. Rakazo and Goose use Apache-2.0. OpenClaw, Hermes Agent, OpenHands, LangGraph, and CrewAI use MIT on the license files checked for this page. Dify uses a modified Apache-2.0 with extra conditions on multi-tenant service and on its logo and copyright in the frontend."
  - question: "Do I still pay if the software is open source?"
    answer: "Usually yes, for the model provider and the machine. Some projects also sell optional hosting. Open source describes the license of the code you run, not a promise of a zero-cost model."
comparison:
  caption: "Projects named in this page, from their public repos and docs on October 7, 2026. Not a ranking."
  columns:
    - "Project"
    - "License"
    - "What you run"
    - "Built for"
  rows:
    - topic: "Rakazo"
      cells:
        - "Apache-2.0"
        - "Docker images or source, then chat"
        - "Persistent bots in the Rakazo apps"
    - topic: "OpenClaw"
      cells:
        - "MIT"
        - "Gateway on your machine"
        - "Assistants in the chat apps you already use"
    - topic: "Hermes Agent"
      cells:
        - "MIT"
        - "Desktop app or CLI"
        - "A local agent, plus an optional messaging gateway"
    - topic: "OpenHands"
      cells:
        - "MIT"
        - "Agent Canvas, with or without Docker"
        - "A control center for coding agents"
    - topic: "Goose"
      cells:
        - "Apache-2.0"
        - "Desktop, CLI, or API"
        - "General work on your machine"
    - topic: "LangGraph"
      cells:
        - "MIT"
        - "A library in your process"
        - "Stateful agent graphs you build"
    - topic: "CrewAI"
      cells:
        - "MIT"
        - "A Python framework"
        - "Multi-agent workflows you build"
---

"Best" is the word people type. It is a poor word for this set. An agent you chat with, a gateway for Telegram, a desktop coding control center, and a Python library are not substitutes. This page separates projects you run as applications from libraries you embed, names the license each repo actually uses, and says what each one is for. It is not a benchmark, and it is not ordered by stars.

The descriptions were checked against each project's public repository or docs on October 7, 2026. If a README moves, the README wins.

## How this list is split

The first group is software you install and then use: Rakazo, OpenClaw, Hermes Agent, OpenHands, and Goose. You can self-host them. They still call a model provider unless you point them at a local model.

The second group is libraries: LangGraph and CrewAI. You do not "log in" to them. You write a program that uses them, then you host that program.

Dify is called out separately because people group it with agent platforms, and its license is not stock Apache-2.0. Skipping that and calling it Apache-2.0 would be wrong.

Hosted products with no source you can run are outside this list. The [alternatives hub](/alternatives/) compares some of those with Rakazo.

## Rakazo

Rakazo is an open source platform for persistent AI teammates, licensed Apache-2.0. You run published Docker images or a source checkout. The web app, the Electron desktop app, and the Expo mobile app are clients of the same API. Hosted Rakazo Cloud is not generally available.

A bot has conversations, memory, routines, and history. Routines are readable Markdown and can run on a schedule. Browser, terminal, files, and a graphical desktop are available. The default computer is local Docker. E2B, Daytona, CreateOS, and Box are optional remote computers. You bring model credentials: OpenAI, Anthropic, Google, OpenRouter, Vercel AI Gateway, an OpenAI-compatible endpoint, or a local server such as Ollama, LM Studio, llama.cpp, or MLX. Each bot can use a different model.

A bot can pause for approval at a boundary you set. Actions are recorded in an audit log on the deployment. Postgres and bot files stay on the machine you operate. Prompts still go to the provider you chose.

The day-to-day surface is chat. A new bot interviews you, and you manage it from that chat. Optional connectors for Slack, WhatsApp, Telegram, iMessage via Sendblue, and Feishu/Lark are extras.

Rakazo fits repeated operational work where you want the bot, the routine, and the approval in one app, and you are willing to run Docker. It is a poor fit if you want a library inside an existing service, or if you want the agent to live only inside Discord with no Rakazo app. The [self-host page](/self-hosted-ai-agent/) is the install. The [OpenClaw](/openclaw-alternative/) and [Hermes](/hermes-alternative/) pages are the closest shape comparisons.

## OpenClaw

OpenClaw is a self-hosted gateway that connects chat apps to an assistant on your machine. The license is MIT. The project describes the OpenClaw Foundation as an independent 501(c)(3). Its docs say there is no hosted service in the middle and no paid tier for the software.

You install it with the project's script, go through onboarding, and run a Gateway. That process can stay in a terminal or be installed as a background service. Configuration lives under `~/.openclaw`. Channels documented by the project include Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and others via plugins, plus a browser Control UI and mobile nodes.

The install docs read for this page say Node 26 is recommended, and that Node 24.16+ or Node 26.1+ are supported. The installer can provision Node. Sandboxing of tool execution is off by default. When enabled, documented backends include Docker, Podman, SSH, OpenShell, and Crabbox. The Gateway process stays on the host.

OpenClaw fits when the assistant should show up in chat apps you already use, and you want one gateway on hardware you run. It is a different product from a teammate UI. The [three-way note](/blog/openclaw-vs-hermes-vs-rakazo/) compares that setup with Rakazo and Hermes without turning it into a race.

## Hermes Agent

Hermes Agent is Nous Research's MIT-licensed agent. You can run it on your own machine. The project also documents optional Nous Portal credits and cloud hosting.

There are two installs, and they should not be collapsed into one. The desktop app on macOS, Windows, and Linux shares `~/.hermes/` with the CLI. The desktop guide says first-run onboarding can reach a first message in seconds, and that choosing a provider later skips provider setup. The app starts a local backend. That chat does not require the CLI.

The CLI quickstart is an installer, `hermes setup` (Quick Setup, Full Setup, or Blank Slate), and `hermes model`. Secrets go in `~/.hermes/.env`. Other settings go in `~/.hermes/config.yaml`. The quickstart says a model needs at least 64,000 tokens of context. Messaging platforms use `hermes gateway setup` and a gateway process that the desktop guide describes as separate from the app's local backend.

Hermes fits a person who wants a desktop agent or a terminal agent, with files they can inspect under their home directory, and who will add a gateway only if they want chat apps. It is not a drop-in for a multi-user web app with a Postgres audit log. Read their docs for the skills and memory behavior they describe. This page does not add claims beyond that.

## OpenHands

OpenHands Agent Canvas describes itself as a self-hosted developer control center for coding agents and automations. The repository README says it can run the OpenHands agent and other ACP-compatible agents, including Claude Code and Codex, across local, remote, and cloud backends. The LICENSE file at the root of the GitHub repository is MIT.

The quickstart's first option is a global npm install, with Node.js 24 or later and `uv`:

```bash
npm install -g @openhands/agent-canvas
agent-canvas
```

The README warns that this option runs the agent server directly on the machine you install on, and that the agent will have full access to your filesystem. Docker sandbox options are separate. The README also says you can optionally run agents on OpenHands Cloud or OpenHands Enterprise infrastructure. This page does not describe the commercial terms of those hosted options. The MIT text above is the repository license that was fetched, not a review of every hosted plan.

OpenHands fits coding work: conversations with coding agents, automations, and backends you switch between. It is a control center for that work. It is not a general teammate for an inbox or a schedule of operational routines, and the unsandboxed install is a real warning, not a footnote.

## Goose

Goose's README describes a native open source AI agent with a desktop app, a CLI, and an API, for code and for other work. The repository is `aaif-goose/goose`. The license file is Apache-2.0. The README says Goose is part of the Agentic AI Foundation at the Linux Foundation.

The same README says Goose works with 15 or more providers, naming Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure, Bedrock, and others, and that it connects to 70 or more extensions through the Model Context Protocol. Those counts are the project's own description, not a measurement made for this page. The desktop app is documented for macOS, Linux, and Windows. The CLI install is a script from the project's stable release.

Goose fits someone who wants a general agent on their own machine, with a desktop app or a terminal, and a wide set of MCP extensions. It is not the same shape as a gateway whose job is to sit behind a dozen chat networks, and it is not a library you import into a service you already wrote.

## Libraries, not apps

LangGraph is a low-level orchestration framework for building stateful agents. The repository `langchain-ai/langgraph` carries an MIT license. You use it by writing software that defines a graph, a state, and the model calls. There is no LangGraph chat app to install from that README, and this page does not describe LangSmith or any hosted pricing.

CrewAI's README calls it an open-source Python framework with high-level abstractions and low-level APIs for multi-agent workflows. The repository license is MIT. The same README describes CrewAI AMP Suite as a commercial control plane with managed deployment, observability, governance, security, and enterprise support, available on-premise or in the cloud. The framework and the AMP suite are different things. Installing the Python package does not subscribe you to AMP.

Use either library when the agent is a feature inside a product you are building and you want to own the process model. Do not pick them when you wanted an application this afternoon. You will be the one who writes persistence, authentication, and the approval UI.

## A license caveat for Dify

Dify, from LangGenius, often appears in lists of open source agent platforms. Its LICENSE file is not the Apache-2.0 text alone. It is a modified Apache-2.0 with additional conditions. Two of them matter before you build on it.

The file says you may not use the Dify source to operate a multi-tenant environment unless Dify authorizes that in writing. In that document, one tenant corresponds to one workspace. It also says you may not remove or modify the logo or copyright information in the Dify console or applications when you use the frontend. That restriction does not apply to uses that do not involve the frontend. The frontend is defined there as the `web/` directory, or the web image when you run Docker.

That is a short caveat, not a full review of the license. Read the file if you are choosing Dify. Do not describe it as the same grant as Rakazo's or Goose's Apache-2.0.

## How to choose

Start from the job, not from a list position.

If you want persistent bots, readable routines, approvals, and an audit log, and you will run the server, use Rakazo. The install is Docker, then chat.

If you want one assistant inside the chat apps you already have, use OpenClaw, and read the sandboxing page before you turn tools loose. The Gateway is the product.

If you want a desktop or terminal agent with a home-directory config, use Hermes, and add the messaging gateway only when you need it. Desktop onboarding and the CLI quickstart are both real paths.

If you want a control center for coding agents, use OpenHands, and do not take the unsandboxed npm install lightly.

If you want a general desktop and CLI agent with many MCP extensions, use Goose, and treat the provider and extension counts as the project's own claims.

If you are building the agent into your own service, use LangGraph or CrewAI and plan to operate what you build. If you are evaluating Dify, read the modified license before you assume you can resell a multi-tenant copy or restyle the console.

Two checks belong on every option. First, the license file, not a badge in a blog post, including this one. Second, where prompts go. Self-hosting the agent does not self-host the model. Unless you select a local model server, the provider still sees the prompt.

Nothing above says one project will do better work. It says they are different pieces of software, and the useful choice is the one whose shape matches the work.
