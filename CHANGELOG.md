# Changelog

Notable product changes in Rakazo. This is for people following the repo, not a dump of every commit. GitHub Releases still mark tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- The phone surface became a multi-platform messaging surface built on the open-source Chat SDK. Slack, WhatsApp Business Cloud, and Telegram DMs now work alongside iMessage/SMS (Sendblue). Link a chat app to your account from Messaging settings on the web: pick a bot, send the short-lived code to the line, and that conversation reaches that bot — each app can point at a different bot. Unknown senders are ignored unless `MESSAGING_OPEN_SIGNUP=true`, which restores the old text-first auto-provisioning (and is the only mode that needs the deployment model key). Webhooks move to `/api/v1/messaging/webhook/<provider>` (the old Sendblue path still works), and each platform mounts when its env credentials are set — see `.env.example`. Group channels remain iMessage-only for now; other platforms are 1:1 until their channel semantics are mapped.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Added

- Voice mode: speak replies, hold-to-talk dictation, and half-duplex calls. Speech sits behind a `VoiceProvider` interface (ElevenLabs, OpenAI, Cartesia) so the product is not tied to one vendor. Keys stay on the server.
- Electron first-run: Docker (default) or this Mac. This Mac runs the bot shell as you, with working directories under your home folder. macOS does not show its own permission dialog; the consent is Rakazo's. The choice is owner-only and is refused when `SANDBOX_PROVIDER` is not `docker` (so E2B and test fakes cannot enable it).
- GitHub Copilot and SuperGrok / X Premium sign-in via Pi device-code OAuth (`openai-codex`, `github-copilot`, `xai`). Claude Pro is still omitted because Pi's Claude login uses a localhost callback that does not work from the web app.
- Spawn peer bots (each with its own thread and computer) and short-lived in-thread subagents.
- ChatGPT Plus or Pro sign-in for model access.
- Mobile: point the app at a self-hosted API origin, a native iOS inbox, and take control of the live desktop.
- Provider-neutral integrations: managed apps through Composio or Pipedream Connect, plus encrypted user-installed Treg, HTTPS MCP, and OpenAPI tool sources on web and mobile.
- Revoke for connected Composio plugins.
- Routines in plain language instead of raw cron.

### Removed

- Unused Grant folder picker in the desktop app. Bots never got a host folder that way.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
