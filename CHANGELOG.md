# Changelog

Notable product changes in Rakazo. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Added

- Voice mode: spoken replies, hold-to-talk dictation, and half-duplex calls with ElevenLabs, OpenAI, or Cartesia.
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
