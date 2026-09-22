# Changelog

Notable product changes in Rakazo. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- A bot on a reasoning model could answer with "No response. Try again." on a harder question: thinking is billed against the same output ceiling as the reply, and the 4k default left nothing for the reply itself. Reasoning models now get a 32k output ceiling instead, still bounded by whatever the model itself allows.
- A newly created bot's thread opened empty and stayed silent until given real work, so a misread `title`/`description`/`instructions` went unnoticed until it cost a run. Creating a bot now queues one turn where it states how it understood its role and asks for anything it needs.
- A message sent while that introduction was still running was answered by the intro, which cannot use tools. The message now starts its own run, and the introduction no longer sends a finish notification.
- Every turn failed on Claude models through Amazon Bedrock with "input_schema does not support oneOf, allOf, or anyOf at the top level": `request_secret` declares its two destinations as a root `oneOf`, and Anthropic rejects the whole request for it. Root unions in tool schemas, including ones from MCP servers, are now merged into a single object schema before they reach a provider; the executor still enforces credential or `connectionId`, not both.
- Pipedream exposed every tool of every connected app at once, so a handful of apps could fill a run's tool list. Above 20 tools the connector now offers the same lazy catalog the MCP connector uses (`pipedream_search_tools`, `pipedream_load_tool`, and `pipedream_execute_tool`), with names grouped by app.
- The Needs you computer card in a thread now includes Open, which opens that bot's computer the same way the computer panel does, including from a group member bot.
- Bots with more than 20 MCP tools failed on every Claude model behind a Claude Pro/Max/Team sign-in with "You're out of extra usage": Anthropic rejects Claude Code OAuth requests that carry a tool named `mcp_*`. The lazy catalog wrappers are now `connectors_search_tools`, `connectors_load_tool` and `connectors_execute_tool`.

### Changed

- Message bubbles in the web/PWA transcript use more of a wide window's width (70%/74% caps raised to 84%/88%, still leaving room for the hover-actions gutter), instead of leaving a quarter to a third of a long message's row empty.
- Every run's system instructions now state the current date and time (UTC), so bots judge deadlines, recency and scheduling from the real present instead of guessing it from training data or quoted timestamps.
- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Added

- Voice mode: spoken replies, hold-to-talk dictation, and half-duplex calls with ElevenLabs, OpenAI, Cartesia, or Fish Audio.
- Desktop owners using Docker can opt into running bot shell commands directly on their computer. This grants access under the owner's OS account; see [computer providers](docs/self-host.md#choosing-a-computer-provider).
- GitHub Copilot and SuperGrok / X Premium sign-in for model access.
- Spawn peer bots (each with its own thread and computer) and short-lived in-thread subagents.
- ChatGPT Plus or Pro sign-in for model access.
- Mobile: point the app at a self-hosted API origin, a native iOS inbox, and take control of the live desktop.
- Provider-neutral integrations: managed apps through Composio or Pipedream Connect, plus encrypted user-installed Treg, HTTPS MCP, and OpenAPI tool sources on web and mobile.
- Disconnect connected Composio plugins.
- Routines in plain language instead of raw cron.

### Removed

- Nonfunctional Grant folder picker in the desktop app.

### Messaging upgrade notes

- Webhooks use `/api/v1/messaging/webhook/<provider>`; the previous Sendblue path remains supported.
- Configure credentials for each messaging provider in `.env`; see [.env.example](.env.example).
- Unknown senders are ignored by default. `MESSAGING_OPEN_SIGNUP=true` restores automatic account
  creation from incoming messages and requires a deployment model key.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
