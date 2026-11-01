# Changelog

Notable product changes in Rakazo. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.0] - 2026-11-01

### Security

- Row-level security's system bypass now needs a key that only the app holds, so SQL running for one Space can no longer give itself access to every Space. `db:migrate` sets it up on upgrade with no new configuration. Installs whose runtime database login has no password keep the old behavior, and `db:migrate` warns about it.
- Hosts hardened with `harden-host.sh` now drop inbound IPv4 TCP packets that carry IP options and turn off multipath TCP, and production Caddy no longer listens with multipath TCP. This blocks the known path to CVE-2026-98432, a remote Linux kernel bug, until a fixed kernel is running. Rerun `harden-host.sh` and recreate Caddy now, then install the fixed kernel and reboot as soon as your distribution ships it. The host check now reports updates waiting for a reboot ([production](docs/self-host-production.md)).
- Dropping a connection partway through a WebSocket upgrade no longer crashes the server. Before, this took down the API (through the Local Computer Access device socket) or the web server that Compose runs (through the screen proxy) for every user, and it worked even without screen access.
- Logs redact more sensitive data. Header values echoed in error messages, stacks and reasons are replaced with fixed text, the host audit shipper redacts sensitive free text before it truncates it, and caller IP and user agent are kept only on security events.
- While someone is teaching a bot on its computer, `open_path` and `launch_app` are refused like the other screen tools. A routine, webhook or channel run can no longer open windows on the screen being recorded.
- Log redaction now hides the credential after any HTTP auth scheme (`Basic`, `Digest`, `token`, not only `Bearer`), API keys in headers like `x-api-key`, and quoted JSON fields such as `access_token`, `refresh_token` and `client_secret`. A very long log message can no longer stall the server while it is being redacted.
- The MCP SDK is upgraded to 1.32.2, which fixes two client-side advisories about OAuth credentials and cross-origin redirects. Rakazo already blocked both paths, so this is a second layer of protection.
- When a batch of Composio actions includes a split-out Dropbox folder listing, that listing must now use an account the workspace connected. A call naming any other account is refused before anything in the batch runs.
- Composio and Pipedream connections now record the exact external account you approved and use only that account, so people with several accounts on one app no longer get tools acting as whichever account the provider picks. Older Pipedream connections that never stored an account stop offering tools until they are reconnected.
- A bot's memory tools remove the Serenity access token from errors and results before the model sees them, in case the server or a proxy repeats it.
- Values you set for an MCP server's environment variables and headers are hidden from tool results and errors, whatever their names. Short values, numbers and common config words stay visible.
- When stdio MCP servers are allowed through `npx`, Rakazo starts only a plain npm registry package (`npx <pkg>`, optionally with `-y`, or `npx -p <pkg> <bin>`) and installs it without running install scripts. Any other `npx` form is refused with "This npx command isn't supported here" ([integrations](docs/self-host-integrations.md#mcp-servers)).
- Saving a remote MCP server whose URL holds a credential in its query string (`?api_key=`, `?token=` and similar) is refused, with a message asking for it in a header, where it is stored encrypted. Servers already saved keep working.
- In a shared Space, only the person who made a routine can delete it, the same rule as editing it.
- The packaged desktop app labels a request to its local stack as coming from the app only when it really does. Sign-in popups and the sandboxed preview of bot-made HTML can no longer pass the API's origin checks as the app.
- The mobile SSO sign-in proxy only redirects to the configured SSO provider's sign-in page and is closed when SSO isn't set up. Before, a link on the API's domain could send people to another site or sign them in to someone else's account.
- Signing in with an emailed code to an account whose address was never verified now also removes its passkeys, linked chat addresses, pending chat link codes and paired computers. Someone who made the account first can no longer keep access after the real owner takes it back.
- Link icons are fetched only from a link's main domain, even for oddly formed hostnames, and hosts with no main domain get no icon. Domains with non-Latin letters in your messages (like `münchen.de`) are read whole, so a run no longer trusts the wrong site.
- A change trigger that calls a connected app's tool on a timer gets the same Auto Review check as calling that tool right away. A read chosen after outside content entered the chat can no longer be saved as a repeating watch without review.
- Auto Review shows its checker an action's full arguments, up to 8,000 characters, instead of only the first 1,200. Longer actions always ask the owner, with the reason "Too long to review.", so a batch can't get approved with its later steps unread.
- Charts and diagrams a bot draws stay inside their own frame. They can no longer restyle or cover the app, load remote images, or open links without the "Open external link?" prompt, and Mermaid diagrams can't inject their own CSS or fonts.
- Deploys set the runtime database login with a password hash instead of the plain password, so the password can't end up in database logs. The limits on plugin submissions and CSP reports group IPv6 callers by /64 network, and a flood of new callers no longer resets everyone's limit.
- Connecting a Slack workspace now finishes on a signed-in Rakazo page, and only the person who started the connection can finish it. Before, anyone who opened your approval link could connect their workspace to your bot. The redirect URL registered in Slack does not change.
- A web voice call ends when you sign out, another tab signs out, or another account signs in, and the page then reloads. A late hang-up or answer can no longer go out with the next user's session. Signing out now always goes to the sign-in page.
- Stdio MCP servers can no longer be launched through package managers or runners other than `npx`: `npm`, `pnpm`, `yarn`, `bun`, `bunx`, `deno`, `uv`, `uvx`, `pipx` and `corepack` are refused even if the command allowlist includes them, because they can download and run any code. Install servers from other ecosystems on the host and allowlist their binary instead.
- A mobile voice call now ends when you sign out, sign in to another account or switch server. Before, the call's later requests could go out under the new session.
- When another worker takes over a bot's run, the worker it was taken from can no longer run tools that reach outside Rakazo, message other bots, request calls, launch cloud agents or change the takeover card. A stalled worker that woke up late could repeat an action the user only asked for once.
- The desktop app window now stays on its connected server when that server redirects to another site. The other site opens in the system browser instead of loading inside the app window, and the desktop sign-in and update actions only answer the server's own page.
- A routine that watches a command's output now hides saved-login hidden fields and recent card numbers and payment tokens in its change note and pause message, the same way runs already do. A watch whose output contained one of these values fires once more after upgrading.
- Computers that run as Kubernetes pods get the same container restrictions as Docker computers: every Linux capability dropped, privilege escalation off, and the runtime's default seccomp profile. This applies to newly started pods.
- Signing out of the web or desktop app, or deleting the account, now removes unsent composer drafts saved in the browser. The next person to sign in on that browser no longer sees the previous person's half-written messages.
- Signing out of the iPhone or iPad app, or switching servers, now clears the previous account's notifications from Notification Center, as Android already did.

### Added

- Self-hosted deployments can run several Photon projects, each giving a person its own iMessage number, so different bots are reachable over iMessage, using `PHOTON_PROJECT_ID_<NAME>` and `PHOTON_PROJECT_SECRET_<NAME>` pairs ([integrations](docs/self-host-integrations.md)).
- iMessage through [Photon](https://photon.codes): set `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` to link a bot to an iMessage number, with no public URL needed ([integrations](docs/self-host-integrations.md)).
- A server running on macOS offers a keyless **macOS** voice provider that reads replies with the voices installed on that Mac. Speech is rendered into a clip, so it plays and stops on the listener's device like any other voice ([macOS voices](docs/self-host-models.md#macos-voices)).
- With a key manager configured, secrets in `.env` such as `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` can be stored wrapped by it, so a copy of `.env` no longer holds usable secrets. The API, worker and server CLIs unwrap them at startup, and `AWS_KMS_PROFILE` lets those CLIs use short-lived AWS credentials from a laptop ([wrapped settings](docs/content-encryption.md#wrapped-settings)).
- Bots can search all of your own chats in the current space, not just the chat you are in, and open the messages they find. They can also try several keyword variants in one search. This only works in runs you start directly, never in channel, webhook, routine or bot-to-bot runs, and never reaches another member's chats.
- Login cards have a "Save to Vault" switch, on by default. Turn it off and the bot can sign in for this run only: the login is kept encrypted for that run and that site, and deleted when the run ends.
- When you add a custom MCP server, OpenAPI or GraphQL source on mobile, you can choose how it signs in: bearer token, an API key in a header you name, or OAuth in your browser for MCP servers.
- `SANDBOX_COMPUTER_MOUNTS` (Docker computers only) mounts host folders into every bot computer as `source:target[:rw][:rslave]` entries. Mounts are read-only unless an entry adds `rw`, and every bot in every Space sees them. Risky source paths are refused at startup ([shared host folders](docs/self-host-docker-computers.md#shared-host-folders)).
- `MAX_ATTACHMENTS_PER_MESSAGE` (1 to 100, default 4) sets how many files fit in one message. Web, desktop and mobile use the server's limit.
- Plugin authors can submit a public GitHub repository to the Rakazo marketplace from the website or the API. Admins approve or reject submissions on `/admin/plugins`, and approved plugins are listed under "Rakazo" in the in-app marketplace. Admins are the verified accounts listed in the optional `RAKAZO_ADMIN_EMAILS`.
- boxd as a remote computer provider: set `SANDBOX_PROVIDER=boxd` and `BOXD_API_KEY` (and optionally `BOXD_ORG`). Each computer runs in its own microVM, and stopping one suspends it with its memory, so open programs and pages are still there when it resumes.
- Wuying as a computer provider (`SANDBOX_PROVIDER=wuying`): Team and Private Computers can run on an existing Alibaba Cloud Wuying Windows cloud computer, and people can watch or take over its screen in Rakazo. Set it up with the `WUYING_*` settings. Everything on it shares one Windows desktop and account, so it is only for trusted deployments.
- The mobile and desktop apps can use a self-hosted server behind an access proxy such as Cloudflare Access. When choosing an existing server, add request headers (for example a service token). The apps send them only to that server, and the computer screen keeps working through the proxy.
- On the macOS desktop app, dictation and the listening side of voice calls use the Mac's built-in speech recognition, so they work without a voice provider. When the language has a local model, recognition stays on the Mac.
- Excel spreadsheets (XLS and XLSX) can be attached to chat messages on web and mobile.
- Dictation and calls listen for the speaker's own regional variant of Spanish and other languages (for example `es-CL` or `es-MX` instead of always `es-ES`). Calls understand Spanish goodbyes and yes/no answers, voice errors are translated, and routine times use the language's clock (21:00 instead of 9:00 PM).
- The Simplified Chinese and Spanish web apps are fully translated. Search result kinds, computer card states and credit prices also follow the active language and locale.
- The mobile composer keeps a separate draft for each conversation, so text you typed survives switching chats or closing the app, as on web.
- On mobile, swipe an unzoomed image down to close the image viewer.
- A production API now logs a warning at startup when `ENCRYPTION_KEY` is shorter than 32 characters or still the example value from `.env.example`. The key is still accepted.
- Bots can change their own instructions, model, thinking level, read-aloud and voice when you ask in a chat you started. Changes to model, thinking, read-aloud or voice post a "Settings updated" card with Undo. Bots can also read or change your timezone and marketing-email setting from chat. Instruction changes go through the usual approval, which Auto Review can grant, and are kept in instruction history. Runs someone else started cannot change instructions.
- Bots answer questions about how Rakazo works, such as connecting Slack, credits, computers or self-hosting, by reading the matching published docs page instead of guessing.
- On a Mac running the desktop app, bots can see and use one app at a time in the background without moving your pointer or changing focus. You allow it once per space, covering every bot and chat of yours there. The first time a bot uses an app, the desktop app downloads a pinned, checksum-verified driver and asks macOS for Accessibility and Screen Recording permission.
- Each organization has a permanent audit log of consequential bot actions, who approved or denied them, auto-review decisions, and changes to approval rules, credentials, secrets, spaces and sign-ins. Owners and admins can export it as JSON Lines. Self-hosters can set retention with `AUDIT_EVENT_RETENTION_DAYS` (default 365) and forward events with `AUDIT_LOG_WEBHOOK_URL` and `AUDIT_LOG_WEBHOOK_AUTHORIZATION`.
- Self-hosters can run `docker compose -f docker-compose.images.yml exec api node dist/cli/diagnostics.js` to print a redacted report to paste into a GitHub issue. It covers the revision, enabled features, migration status, MCP server health and recent runs, and leaves out names, secrets and content ([reporting a problem](docs/self-host.md#reporting-a-problem)).
- `RAKAZO_WEB_BIND` lets the self-hosted Compose stacks publish the web port on the local network, so a phone on the same Wi-Fi can connect. It defaults to `127.0.0.1`, and the API and all other ports stay on loopback.
- On deployments that sell model credits, admins can give free model credits or free own-key months to any email from `/admin/access`. The person receives the grant once their email is verified, whether they signed up before or after it was made.
- On paid hosted billing, each organization gets a monthly allowance for cloud computers: $5 (25 hours) on own-key plans, and 20% of the monthly amount on credit plans. Billing shows "Computer hours left". Once the allowance is used up, computers don't start until next month, and a running computer is saved and stopped. Self-hosted installs without credit billing have no limit. Computer time for a computer the provider lost now ends when it was last seen running.
- Custom endpoint model connections have a Protocol setting on web and mobile: Chat Completions, Responses or Anthropic Messages. This lets you use servers and gateways that don't serve Chat Completions. Existing connections keep Chat Completions.
- Cmd/Ctrl-K can now start a new bot, group chat or private space, open Connect apps, Skills or any settings page, and switch between System, Light and Dark themes. Bots stay at the top of the list.
- Keyboard shortcuts switch to the next or previous bot: Ctrl+Tab and Ctrl+Shift+Tab in the desktop app, and Cmd/Ctrl+Shift+Down and Up in the browser ([shortcuts](docs/desktop-app.md#shortcuts)).
- Custom endpoint model settings have a search box once the discovered model list gets long, and say when the search hides models you already selected.
- The iOS app runs as a native iPad app, with the chat list beside the open chat in portrait and landscape.
- When the ticket board is enabled, the mobile app has a Board in Settings where you can view tickets by column, move them between statuses and pull to refresh.
- The mobile app is available in Spanish.
- Unknown web addresses show a "Page not found" page with a button back home instead of a blank screen.
- Bots can now use apps on the owner's Windows PC through the desktop app, as they already could on a Mac. The first time a bot needs an app, the desktop downloads a small, checksum-verified screen driver. Windows security settings such as Smart App Control can stop that driver from starting.
- New desktop keyboard shortcuts: Cmd/Ctrl+, opens Settings, Cmd+1–9 jumps to a bot, Esc in the message box stops the reply, Cmd+F searches, Cmd+B toggles the sidebar, and Cmd+[ / Cmd+] go back and forward. Typing anywhere moves focus to the message box, and the app menus now list these shortcuts, including a new Go menu.
- iOS Shortcuts and Siri actions: Message Bot, Ask Bot (returns the reply), Run Routine, Open Bot and Start Voice Chat. They also work from the Action button.
- Self-hosters who sign their own apps can set `RAKAZO_PASSKEY_RP_ID` at build time so the macOS app's passkeys work on their own domain. `RAKAZO_PASSKEY_DEVELOPER_MODE=1` lets iOS and macOS development builds use passkeys on a server that is only reachable on a private network.
- Each MCP server has a **Keep tool results whole** option under Advanced, so long results such as email bodies are no longer cut in the middle. If a whole result cannot fit the model, the turn fails with a message naming the setting.
- The bot's page tools can now read and act inside embedded frames, including filling saved logins in sign-in forms framed from the login's own site. `browser_navigate` returns the page, so no extra snapshot is needed. On Docker computers the page browser now runs on agent-browser. The computer image and API should be updated together.
- Bots have a `feedback` tool for bug reports and suggestions. It follows the normal approval modes, is offered only in chats the user started, and saves reports on the server with the chat and run they came from. On a self-hosted server the reports stay with the operator.
- After a few messages, web and desktop show a one-time prompt offering a link to star the project on GitHub. Dismissing it hides it for good.

### Changed

- Only admins listed in `RAKAZO_ADMIN_EMAILS` can add or edit stdio MCP servers, and bots can add remote servers only. Deployments that use stdio servers should set `RAKAZO_ADMIN_EMAILS` before upgrading; existing stdio servers keep running ([integrations](docs/self-host-integrations.md)).
- Messages between bots show up in a bot's chat as one centered line, such as "Messaged X", "Message from X" or "N messages with X". Tapping it opens the bot-to-bot conversation read-only. Replies meant for you stay in your chat.
- A bot you tag in the message box appears as a card where you typed it, with its avatar and color, instead of as a separate pill. Backspace removes the whole mention. On mobile the mention is tinted in place.
- Importing an agent from OpenClaw, Hermes or another assistant starts only from "Import an agent" in Settings → General, and always creates a new bot. Import no longer appears in onboarding, the New bot dialog or chat drag-and-drop, and it can no longer replace Chief, merge into an existing bot or be undone.
- When a bot asks you to take over its computer, it now answers your other messages and other bots while it waits. A takeover request that nobody acts on ends after 30 minutes instead of a day.
- Bots switch to the Space's backup model when the provider rejects the main model's key or sign-in, or that connection is gone, instead of failing. A main model with thinking turned on can now fall back to a backup that can't think, which runs with thinking off. Runs pinned to one model still fail as before.
- When a provider rejects a subscription sign-in for good, Rakazo keeps the model connection and every Space's model choices, and marks the connection "Sign in again". Signing in again renews the same connection, so you don't have to set up each Space again.
- An MCP server that only connects with a registered OAuth client now shows "Needs an OAuth client ID" instead of a raw error. Connect opens its Advanced settings with the client ID field focused. After you add a remote server, its first check result shows in place.
- The desktop app on Windows uses the standard Windows title bar and window buttons instead of macOS-style colored buttons.
- On Android, the inbox **+** opens a native dropdown with icons (New bot, New group chat, New private space) instead of an alert dialog.
- New bots with the Rakazo avatar style get a color from the avatar color picker. Existing bots keep their saved color.
- Mobile voice prepares the next sentence's audio while the current one plays, so multi-sentence replies have no extra pause between sentences.
- A computer can go to sleep while its run waits on an unanswered question or approval. Answering the card starts the computer again.
- With object storage turned on, only Docker computers download their saved home before starting. Remote computers resume their own disk without waiting on that download and without failing when the stored copy can't be reached.
- Account, product and marketplace emails share one branded layout. When welcome emails, a mail provider and referrals are all enabled, account owners get one email about Invite friends about a day after signing up.
- Runs that need a computer keep retrying for about a quarter of an hour during a computer provider outage, instead of failing after about a minute and a half. More Boat failures count as provider outages, such as an account out of paid time and failed file transfers, so computers answer "unavailable, try again" instead of a server error.
- Computer home saves leave out caches, dependencies, build output, logs and core dumps, and new saves are limited to 5 GiB and one million files. When a computer can't be saved, its chat gets a note saying so, and the computer keeps running unsaved.
- A plugin with a skill that has the same name as a built-in skill can now be installed. Rakazo leaves out just that skill, and the plugin preview lists it under "Not added" with the reason, instead of refusing the whole plugin.
- The bot list loads faster for bots with long run histories, such as bots with frequent routines. The new index is built without blocking writes, but it can take a while to build during the deploy on a large database.
- Opening a monthly checkout no longer holds a database connection while waiting on the payment provider, so slow checkouts can't stall other requests on the same server.
- The read-only peer chat closes with an X in the header instead of a text button, and its title stays centered.
- The mobile image viewer no longer shows the filename, and chat image thumbnails on mobile no longer have a padded frame around them.
- On iOS, organizing a chat into sections opens a native form sheet that you can swipe to dismiss.
- **Never ask** now lets bots do what they're asked, including scheduling routines for other bots, editing groups, changing instructions or models, creating spaces and writing in webhook-started runs. It still refuses to accept another owner's bot connection when the run could have been steered. In Ask and Auto, scheduling another bot and creating or editing a group are now ordinary approvals that offer "Always allow this tool".
- Clicking a bot's name in the chat header opens one sidebar with Computer, Routines and Advanced tabs. It replaces the separate computer button and the settings toggle.
- A bot's profile on mobile has an Edit button under its name in place of the "Chat settings" row. Its Routines, Artifacts and Computer rows now have icons, and the Computer row shows Running or Asleep.
- Mobile voice settings start on the phone's own voice unless a hosted voice is already set up. The picker no longer shows subtitles, and the server's Mac voice is labeled "Server (Mac)".
- A cloud computer stays awake while a coding agent such as Codex, Claude Code or OpenCode is working on it, even past the usual uptime cap. It goes to sleep soon after the agent finishes or sits idle at its prompt.
- When a provider's quota won't reset for more than an hour, such as a free model's daily limit, the run switches to a backup model right away. The error shows when the limit resets, and a routine on your own connection waits until then instead of failing on every run.
- Bots get a small core set of built-in tools and look up the others when they need them. This makes each model call smaller, and the activity line reads "Finding a tool" during a lookup.
- Replies to chat apps such as Telegram, Slack, WhatsApp and iMessage now send separately for each conversation. A slow or stuck send only delays later replies in that same conversation.
- A newly connected MCP server is now available to all your bots, including ones you create later, and a bots dropdown limits it to the bots you pick. The MCP servers panel is a plain list with an "Add server" button, and each server's actions are in a menu. Servers that bots propose and plugin installs still reach only their assigned bots.
- New bots start with cross-space communication turned on. Existing bots keep their current setting.
- A bot's side panel now opens on Routines, then remembers the tab you used last. A stopped or sleeping computer shows the bot asleep with a Wake button instead of a black preview.
- In a routine's run history, a run that posted nothing says "No reply". Runs that did reply open at their first message.
- General and Approvals settings use consistent titled groups. "Advanced" is now an always-open "Chat" group, export, import and delete account sit in a "Data" group, and "Link SSO" moves into Security.
- A custom OpenAI-compatible connection can set a maximum output token limit above 131,072, up to the context window ceiling.
- The monthly Rakazo credits picker adds a $30 option, which is now the default for new subscriptions. Existing subscribers keep their amount.
- Bot avatars now hold still while their bot is idle and stop animating offscreen or when the page is hidden. The app also skips redrawing when the sidebar's background check finds nothing new. An idle desktop window uses far less CPU and GPU.

### Removed

- The approval rule "Preview" tester is gone from web, mobile and the API.

### Fixed

- `RAKAZO_LOCAL_MAX_TOKENS` is now the output limit a local model is asked for. It was only a ceiling, so
  every request still asked for 4096 tokens and a longer reply was cut off and retried. The limit stays
  within a quarter of `RAKAZO_LOCAL_CONTEXT_WINDOW`, and a max-tokens value set on the connection
  overrides it.
- A bot with more than twenty MCP tools reaches them through the lazy tool catalog, and every call through it arrived with empty arguments, so a search or scrape failed with "expected string, received undefined". A free-form object parameter no longer carries an empty `properties` map, which grammar-constrained providers read as "no keys allowed", so the arguments the model builds arrive intact.
- Arguments of a stdio MCP server, which can carry tokens, are stored encrypted with its other credentials and are no longer returned to clients; leaving them blank when editing keeps them. Arguments saved earlier move into encrypted storage automatically when the API starts.
- `MAX_UPLOAD_SIZE_MB` now applies to every API route. Before, uploads above 10 MiB were still rejected and clients were still told the limit was 10 MiB.
- "Use my computer" now connects on deployments where the web server fronts the API, such as the Railway template. Before, pairing worked but the computer stayed Offline.
- When the computer image is missing on the Docker host, the supervisor now pulls it or builds the stock `rakazo/computer` image, instead of failing every start until a restart. This covers a fresh host or one cleaned with `docker system prune -a`.
- Boat, E2B, Novita, Daytona and CreateOS computers that are already running are reused by each run instead of reconnected. Open screens and takeovers no longer disconnect when a bot run starts.
- When Boat's per-IP rate limit refuses a request, Rakazo waits the time Boat gives and sends it once more, instead of failing the run or marking the computer broken.
- A computer Update that fails while saving leaves the computer running instead of marking it broken. Before, the Recover that followed rebuilt it from the last save and lost newer work.
- A lost database reply while saving a computer's home no longer lets a later start or Files read replace recent work with an older snapshot.
- Deleting or replacing a Docker computer now reports an error when Docker fails to remove the container, and keeps the computer so it can be tried again. Before, the container could keep running with nothing tracking it.
- Stopping a computer while it is starting is refused with "Computer is busy" instead of leaving the computer running behind a stopped status.
- A bot can continue after a worker crashed while preparing a takeover, instead of finding its Team Computer busy for 24 hours. Giving a Team Computer's screen to another bot now settles the previous bot's takeover card instead of leaving that bot waiting forever.
- A failed computer sleep check is logged instead of crashing the API or worker. A failed update plan no longer crashes the self-host updater.
- A bot's command on a Docker computer now ends at its deadline when the output stream stalls, instead of hanging until the run is cancelled.
- Desktop commands killed by a signal are reported as failures instead of successes.
- When a background shell command finishes after the bot's turn, the bot now sees the end of long output as well as the start, so it can see why a build or install failed.
- Bot keyboard input on computers types shifted characters such as `?`, `A` or `@` correctly. Screen capture and input reconnect after the display restarts instead of crashing the computer's control service.
- Typing accented letters, symbols and CJK text in the browser now sends keyboard events, and filling rich-text editors uses native text insertion, so editors and validating fields see the change. Browser snapshots now name controls that are labeled through `aria-labelledby`.
- `web_fetch` keeps plain-text responses exactly as the server sent them instead of stripping angle-bracketed text and changing whitespace.
- Previewing a file on a running computer that is too large or not text returns a clear error instead of "Internal server error". Size limits on E2B and Novita computers now also apply to the bytes actually read.
- An OAuth MCP server stays connected when its token refreshes just as its session expires, instead of going unavailable for up to an hour.
- Model discovery handles a server that returns an empty (`null`) model list: it shows the usual message and lets you enter a model ID.
- Schedule times with an hour-only UTC offset, like `2030-03-01T00:30+05`, are accepted.
- Search result excerpts no longer cut an emoji in half.
- After you deny an action, the bot can't ask for the same action again in that run with different arguments. Before, each retry raised another card and push notification.
- The Windows desktop app starts its local stack when Docker Compose wasn't detected or a saved port has been reserved.
- The mobile app opens computer screens on self-hosted HTTPS servers whose screen links point at an address the phone can't reach. Otherwise it shows the existing "cannot reach the screen URL" error with Retry instead of a preview that never loads.
- The Android chat composer stays above the keyboard after navigation-bar, resize or split-screen changes.
- Opening a file from mobile Files no longer fails after eight seconds on a slow connection.
- The mobile inbox shows a "Needs attention" jump only when a visible chat is actually waiting.
- Back is disabled while a bot is being created from an imported agent. Before, a second import could be started before the first one finished.
- Webhook and supervisor requests are accepted when the word "Bearer" in their authorization header uses different capitalization.
- Computers whose home holds Go's read-only module cache can start again after an update, Update or Recover, and can be deleted or have their home replaced. A Team bot's folder is also removed properly. When a home can't be used, the error now leads with the command that fixes it.
- A computer no longer starts on an empty or partly restored home and then saves it over your last good save. When the local cache is missing or a restore didn't finish, the saved home is downloaded again before the computer starts.
- A cloud computer whose server-side copy fell behind its own save no longer fails with "Agent home was saved elsewhere at the same time". It downloads the newer save instead, so the computer can boot, and settings changes and bot deletion work again.
- On Docker Desktop for Windows and Mac, computers with `SANDBOX_COMPUTER_MOUNTS` are no longer rebuilt on every run, which used to close open apps and browser sessions. Each existing computer is replaced once more after upgrading, and its home is kept.
- A running desktop computer is reused when a run starts instead of being reconnected, so its open screens are no longer cut off at the start of every run.
- On Team Computers hosted on a cloud VM, a bot's shell commands use that bot's own screen, so screenshots and recordings from the shell capture the right desktop instead of a blank one.
- Listing a folder on a computer running on your own machine skips links that are broken or point outside the workspace, instead of failing. Folders like a Python virtualenv's `bin` now open.
- When a bot that handed work to another bot is archived or deleted before the work finishes, the result is no longer retried forever.
- Runs waiting for another run of the same bot to release its computer are no longer woken over and over, which hid stuck-work reminders.
- When another worker takes over a bot's run, the worker it was taken from can no longer post messages to the chat, so a chat no longer gets two answers mixed together or the same answer twice.
- Editing a routine while it fires no longer puts its schedule back to a time that already ran, which could stop a scheduled routine for good. If the edit and the run collide, the edit asks you to retry.
- The background worker no longer shuts down, cutting off every run in flight, when its database pool is too busy for a moment.
- With several hostnames in `TRUSTED_PROXIES`, one that stops resolving no longer stops the others from refreshing. Before, a recreated proxy could stop being trusted, and every client then appeared to come from the proxy.
- Only one chat app link code works at a time, even when two codes are requested at the same moment.
- When a model can't use tools, or a ChatGPT sign-in token has expired, the run now shows the clear message offering another model or pointing to your connection settings, instead of a generic provider error.
- The desktop app no longer closes its window and shows a setup error when a server takes more than 20 seconds to load at launch. Updates that fail because the app runs from its disk image or the disk is full now say "Move Rakazo to Applications to install updates." or "Free up disk space to install updates.", and a failed bot export shows an error.
- Changing monthly credits after the monthly plan has ended now refreshes the billing screen so it offers Subscribe again, instead of failing with a server error.
- MCP sign-in no longer gets cancelled while you are still signing in with providers whose login pages cut the popup's link to the app. Closing the popup still cancels right away.
- The Android app no longer replaces a working computer screen with "Retry screen" after fifteen seconds.
- The desktop setup window locks the server address and headers while it saves them, so edits are no longer silently lost. After a failed save, focus returns to the address field.
- Answering a web call and then leaving the page before the call connects now hangs up the call instead of starting it with nobody there.
- On narrow screens, the full-screen call views take keyboard focus and keep it, hide the app behind them from screen readers, and return focus when they close. Typing no longer goes into the hidden message box, and Escape hangs up an active call.
- On mobile, a call hung up while it was still starting no longer records afterward or stops the next call from hearing you.
- Files picked while a message is still sending stay in the composer for the next message instead of disappearing.
- Edits made to a routine while a save is in progress are no longer thrown away when the save finishes.
- An open routine run history shows a finished run's outcome right away instead of still saying it is running.
- Messages waiting to send on mobile are no longer lost after a crash, a full disk or low storage. If saving one fails, the composer keeps your text, and the waiting messages move out of the system cache, which the phone can clear.
- In mobile group chats, each member bot's working or idle status updates as its runs start and end, matching web.
- The muted badge on older mobile bot avatars follows the light and dark themes.
- Pressing Escape to cancel IME input no longer clears the sidebar search.
- Icons in the `@` mention and `/` skill pickers are centered on their two-line labels.
- A bot that was in the middle of replying during a deploy or restart no longer blocks the next message for up to five minutes. The API and worker now finish shutting down and hand back their runs before they exit.
- A bot's assigned MCP servers no longer silently drop out of a run when cleaning up a broken server fails. A failure to look up MCP servers now shows in the thread.
- A saved backup connection is now used when a provider reports exhausted credits inside a wrapped API error. Expired or revoked credentials are no longer mistaken for a temporary outage.
- Composio batch actions, such as Google Calendar listings and Notion queries, no longer sometimes run with empty arguments on some OpenRouter providers.
- A model that runs out of output tokens partway through a tool call now gets an output-limit error instead of "The model provider returned an error."
- A bot's inbound webhook no longer ignores later events that reuse an earlier payload's `id`, such as "paid" and then "shipped" for the same order. Retries are still collapsed by delivery headers, including `webhook-id` and `svix-id`, or when the exact same body is sent again.
- Git event routines now get the repository, pull request and commit details when GitHub sends the webhook as form data, not only as JSON.
- A message that mentions routines is now sent together with those routines' runs, all at once or not at all, so a failed send no longer leaves part of it sent.
- Runs no longer fail with "Internal server error" when the database connection pool is briefly full while the bot checks for new messages.
- A slow integration or payment provider during one user's connection flow no longer gives unrelated users a busy error.
- When Stop can't save a computer or the provider puts off the stop, the computer returns to its previous state instead of showing "Computer failed to boot" while it keeps running unmetered.
- Removing a bot from a group while it is working now frees its computer straight away, instead of leaving it "busy" elsewhere for up to 24 hours.
- A run that finishes while you edit, archive or dissolve its group keeps its real result instead of being marked cancelled.
- With `SANDBOX_PROVIDER=none`, chats no longer stay blank because the computer status fails to load.
- The computer screen now connects when Rakazo sits behind an identity-aware reverse proxy such as Cloudflare Access.
- Wuying computer screens fetch a new one-time login code each time they open or reconnect, instead of staying black after a reopen or bot switch.
- Boat sandboxes that are slow to archive now put off going to sleep and try again later instead of failing. Boat errors behind Cloudflare (520–526, 530) are treated as a Boat outage and retried.
- Remote MCP servers, GraphQL connectors and self-hosted memory services that answer with a redirect are now refused straight away instead of hanging until a timeout.
- Changing a stdio MCP server's command without entering a new credential now clears the stored credential, instead of still showing an empty one as saved.
- The desktop app now recognizes a server's onboarding page in any language. Before, switching to a server in a language other than English failed with "The server page did not become ready."
- A long web chat no longer slows down by redrawing every earlier message while a bot is still writing its reply.
- Pressing Enter or Escape to confirm or cancel an input-method candidate (Chinese, Japanese, Korean) no longer saves, creates or cancels bot, space, account and passkey names early.
- Chats between bots are no wider than a regular chat on wide windows.
- On mobile, the MCP server approval card no longer squeezes its text into a narrow column.
- Simplified Chinese on mobile no longer falls back to English for some newer labels.
- The stuck-loop guard now actually stops a run that keeps making the same call: after 6 identical failures, or 25 unchanged answers or calls that differ only by numbers. A run that keeps sending over-limit `computer_act` or `browser_act` batches stops after four. Before, these loops ran until the run timed out.
- Answering a bot's screen takeover request in a group chat now hands the screen back to that bot, as it already did in direct chats.
- A bot rewriting its own instructions no longer silently overwrites changes the owner made after the run started, such as an import or an edit in Settings.
- Tool calls to an MCP server added under Integrations now share one session for the whole bot run. Servers that pause a step for confirmation, such as Executor, can now resume it instead of answering "Paused execution is unknown".
- When an MCP server sends a result as both structured data and a duplicate JSON text block, the bot receives it once. Large results no longer lose half their room to the copy.
- An MCP server that rejects its OAuth token before it expires now gets a refreshed token, or shows as needing a reconnect, instead of failing every run.
- Very large connector tool results no longer freeze the worker for tens of seconds, which used to make unrelated scheduled runs fail with database errors. Email code sign-in for unverified accounts works again.
- An organization that switches Billing to its own key before connecting one keeps running on its remaining Rakazo credits instead of failing every run.
- A bot with its own model on one of your connections can now run even when no main model is set.
- Long chats no longer pay for a new summary on every turn after a summary comes back over its size limit. Compaction retries after 50 more messages.
- Windows desktop installs can download updates again, because the update feed now names the uploaded installer correctly. The Linux app no longer crash-loops when started by a launcher that closed its output.
- With custom request headers configured (for example behind Cloudflare Access), turning on Live working status on Android no longer crash-loops the app.
- A `WEB_ORIGIN` or `BETTER_AUTH_URL` with a trailing slash no longer breaks connector sign-in with a redirect URI mismatch. A value that is not an absolute URL is rejected at startup.
- Sending a message on web or desktop jumps to the end and follows the reply, and clicking or selecting text at the bottom no longer stops following.
- The chat no longer shows a sideways scrollbar behind the message box when hovering full-width cards.
- Pressing Escape to cancel an input method candidate no longer clears the reply target, closes the computer view while typing a task goal, or closes group settings in Safari.
- A `.csv` attachment that Windows labels as an Excel file now reaches the bot as CSV.
- Updating a bot's computer no longer fails with "Computer is busy" when a message arrives while the update waits.
- Starting a computer after a space has used its monthly allowance now shows the allowance message instead of "Internal server error".
- More provider-side failures, such as a key not scoped to a workspace, too many images, or invalid model output, now end the run with a clear message pointing to the fix instead of a generic server error.
- A bot whose progress update was refused because the turn had just started is now told it can post one later, instead of being told to stop sending updates for the rest of the run.
- Saving a routine edit no longer undoes an enable or disable made elsewhere while the editor was open, or re-enables a one-shot routine that finished in the meantime. A real conflict now shows an error.
- Clearing a conversation no longer fails when it cancels a run started by an older release, and that run's leftover binding no longer keeps the computer from sleeping.
- On mobile, changing a custom model server's URL now clears the selected model, so the new server is not saved with a model it may not serve.
- A newly connected ChatGPT account defaults to a model the account actually offers.

### Self-host upgrade notes

- Production Compose hosts: rerun `harden-host.sh` and recreate Caddy now to block the remote path to CVE-2026-98432, then install the fixed kernel and reboot as soon as your distribution ships it.
- If you run stdio MCP servers, list at least one admin in `RAKAZO_ADMIN_EMAILS` before upgrading. Without one nobody can add or edit them, though existing servers keep running.
- If `SANDBOX_COMPUTER_DNS` is set, computers with restricted or `auto` egress now start only after one of those servers answers from a computer network. A private resolver that restricted egress blocks used to make every lookup time out without warning. Now the start fails with an error that names the setting, so point it at servers reachable from there, such as public resolvers ([self-hosting](docs/self-host.md)).
- If you allow stdio MCP servers through `npx`, a server set up with any `npx` form other than `npx <pkg>` (optionally with `-y`) or `npx -p <pkg> <bin>` stops connecting until it is edited. A package that only works after its own install script runs also stops working ([integrations](docs/self-host-integrations.md#mcp-servers)).
- If your stdio command allowlist includes a runner other than `npx` (for example `uvx`, `pnpm` or `bunx`), servers launched through it stop starting. Switch them to `npx` or to a binary installed on the host.
- Pipedream connections made before account ids were stored stop offering tools. Reconnect those apps.
- Update the computer image together with the API: the page browser on Docker computers now runs on agent-browser.

## [0.3.6] - 2026-10-28

### Added

- `MASTER_KEY_PROVIDER=aws-kms` wraps content keys with an AWS KMS key, so the master key no longer sits on the server. `content-encryption rotate` moves existing keys over ([content encryption](docs/content-encryption.md#external-key-management)).
- Optional point-in-time recovery for the production Compose database: an opt-in sidecar streams encrypted WAL and daily base backups to any S3-compatible bucket, so a lost server costs about a minute of writes instead of up to a day, and `pitr.sh restore` recovers to any moment in the retention window. Off unless enabled; enabling reloads Postgres without restarting it ([point-in-time recovery](docs/self-host-backups.md#point-in-time-recovery)).
- Self-hosted servers can have long replies read aloud as a short summary written by the bot's own model. Off unless `VOICE_SUMMARY_MIN_CHARS` is set; the chat keeps the full reply.

### Changed

- Compose runs database migrations in a one-shot `migrate` container, the only one given the database owner login. Code running in the API or worker can no longer read that login from the container and bypass row-level security. Railway restarts its start script without the login after migrating.

### Fixed

- Approval rules judge each action in a Composio batch even when Composio is connected as an MCP server, so "Always allow" on one action no longer allows every other action through that server.
- Hovering a message no longer places its entire row above the floating chat header and other higher-priority controls.
- "Messaged" and "Message from" markers in a bot's chat are centered like the time separators on web and mobile, so a message from another bot no longer sits on the right with your own messages.
- The chat name and header buttons stay above messages while scrolling, including a message's actions while its menu is open.

## [0.3.4] - 2026-10-25

### Added

- Ollama Cloud preset in Models settings on web and mobile, using an OpenAI-compatible connection with model discovery and no deployment configuration.
- Bot computer homes can live in any S3-compatible bucket instead of only on the server's disk: set `OBJECT_STORAGE_BUCKET` and its connection settings on the API and worker. Homes are encrypted on the server before upload with a per-home key, each saved revision is a single object, and deleting a bot or space makes its stored home unreadable at once. `home-storage migrate` uploads existing homes and verifies each one. Without the setting, homes stay under `DATA_DIR` as before ([self-hosting](docs/self-host-storage.md#bot-homes-in-object-storage)).
- The web app installs as a PWA on phones: Android Chrome offers a real install prompt, the app shell and its assets are cached so an installed app opens offline (showing its reconnecting state), and a new deploy takes over on the next launch or reload. On iOS the installed app runs full screen and keeps content clear of the notch and home indicator, and the installed app no longer zooms on pinch, double tap or input focus (browser tabs still zoom). Electron and dev builds never register the service worker, and API, RPC and screen traffic always go to the server.

### Changed

- Mobile routine and connector mention suggestions load only when requested, with bounded routine-request concurrency.
- MCP result truncation no longer allocates an encoded copy of the full oversized result.
- Sitemap filtering reads blog category counts only for category URLs, without caching content across builds.
- Linux idle probes inspect background-work descriptors in one process. Browser shutdown polls the selected browser and checks for a replacement before clearing lock files.
- Browser unit tests use jsdom's isolated local storage on Node 26 instead of inheriting the host storage global.
- The production and source-checkout Compose stacks run Postgres 18 instead of 16. An existing install runs `infra/compose/upgrade-postgres.sh` once ([upgrading to Postgres 18](docs/self-host-upgrading.md#upgrading-to-postgres-18)): it copies roles, passwords and databases to a new volume, checks grants, row-level security and row counts, and leaves the Postgres 16 volume as it was for rollback. Until then the new database container refuses to start on the old volume instead of starting empty, and production deploys stop before replacing anything. The published-images stack and the desktop app stay on Postgres 16.
- A bot's Model field on the web and in the mobile app, and the mobile model settings, now mark models that cannot read images, as web Settings already did. Moving a bot to a text-only model is no longer a silent loss of image reading.

### Fixed

- Mobile threads now show work started by another client as soon as the run starts, without hiding waiting runs or another group member's error.
- Mobile chat and call subscriptions reject oversized event frames and release their readers after cancellation or connection failure.
- Thread snapshot recovery replays durable events instead of retaining their payloads in memory, without repeating notifications already delivered. Late voice-call snapshots no longer replace newer work or a replacement call.
- The offline installer now rejects missing local inputs without downloading files or starting services.
- Development backups use private permissions. Restore validates files before importing SQL, replaces the saved data tree instead of merging it, and preserves the previous tree for recovery.
- Gemini runs could fail with "Function call is missing a thought_signature" after earlier tool calls in the same turn lost their signature on the way back to Google. Every Gemini request now carries the original signature when one is usable and Google's documented placeholder otherwise.

## [0.3.3] - 2026-10-22

### Fixed

- Images and files a bot attached to its reply in a Telegram chat were dropped, so only the text arrived. They now follow the text as their own messages: PNG, JPEG, GIF and WebP images under 10 MB as photos, anything else up to 50 MB as a document. A file that still cannot be sent after its retries is replaced by a short note naming it, and the text is never sent twice. Other chat apps still receive the text only.

## [0.3.2] - 2026-10-22

### Added

- Stdio MCP servers can connect with OAuth from the MCP servers settings. Rakazo runs the authorization against the provider you name (for example Google), stores the grant encrypted, refreshes it, and passes it to the process through environment variables (`{{oauth.access_token}}` and similar references) or through credential files written to a private temporary directory, so packages that expect a browser login or a token file run unattended. Any client can also limit the scopes it requests.
- Stdio MCP servers can be given environment variables when added in **MCP servers**, under **Advanced**. Values are stored encrypted, like the other server credentials, so API keys a local server reads from its environment no longer have to be pasted into a chat. The form's secret fields no longer invite the browser to fill in a saved password.
- Honcho memory can read an existing Honcho user peer. After entering the workspace another Honcho app already uses, a Space can name that app's user peer under User peer, and recall then includes what Honcho already knows about the user. Rakazo only reads that peer through Honcho's chat; it never creates it or writes conclusions to it.
- Remote MCP servers whose OAuth provider does not offer dynamic client registration can now be connected: enter a client you created in the provider's console under **Advanced** when adding the server, and allow the **Redirect URI** shown there. The client is stored encrypted, its secret is never returned, and it survives **Disconnect**; switching to a different client drops the current grant.

### Fixed

- Self-hosted stacks behind a reverse proxy on the host gave every user one shared sign-in rate limit, so ten failed sign-ins anywhere locked everyone out for 15 minutes. If `TRUSTED_PROXIES` is unset, the API in a container now trusts loopback and the stack's own networks. Outside a container it trusts loopback only. Each client gets its own limit again, and bot computers still cannot choose their address.
- Upgrading a stack installed before restricted computer egress existed stopped its Docker computers from starting until the host firewall rules were installed. The updater now also adds a missing `POSTGRES_APP_PASSWORD` before it recreates services, so the newer Compose files start.
- A message sent to a bot while it was working on another bot's request joined that request. The bot's answer went back to the other bot and was folded under its "Message from" line, so the person who asked saw no reply. The message now waits until that request finishes or stops for input, and is answered in its own turn in the chat.

### Self-host upgrade notes

- Back up Postgres and `DATA_DIR` before upgrading, and store `ENCRYPTION_KEY` (and `ENCRYPTION_MASTER_KEYS`, if set) apart from them. New messages, events, memory and files are encrypted at rest with keys derived from them, and that content cannot be read without them. To roll back to an earlier release, first run `content-encryption decrypt` ([content encryption](docs/content-encryption.md#rollout)).
- Content written before this release stays in plaintext until you run `content-encryption migrate` ([content encryption](docs/self-host-storage.md#content-encryption)); new content is encrypted from the first start. Set the new `CONTENT_ENCRYPTION=off` to store content readable instead: existing ciphertext still reads, and `content-encryption decrypt` converts it. Compose, published images and Railway default to `on`; the desktop app's **This computer** stack and local development default to `off`.
- The API and worker connect as a separate database login, `rakazo_app`, whose password is `POSTGRES_APP_PASSWORD` in `.env`. `install-images.sh`, the updater, the desktop app and `deploy-main.sh` add it when it is missing. If you upgrade a source checkout (`docker-compose.yml`) or run the production Compose commands by hand, first run `echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 16)" >> .env`. Otherwise Compose stops with `Set POSTGRES_APP_PASSWORD in .env`.
- The API and worker containers receive only the settings they read, not the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>`, needs an [override file](docs/self-host-configuration.md#settings-with-names-you-choose). `install-images.sh` names every `.env` setting that no container receives, and layers `docker-compose.override.yml` when it is present.
- Unless `SANDBOX_COMPUTER_EGRESS` is set, Docker computers use restricted egress when the host firewall rules are installed, and open egress as before when they are not ([restricted computer egress](docs/self-host-docker-computers.md#restricted-computer-egress)).
- Only the deployment owner can use an OpenAI-compatible model or voice server on a private address, such as a LAN Ollama, `host.docker.internal` or a host listed in `RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS`. Other users' runs on such a connection fail with "Private model endpoints are limited to the deployment owner." Set `MCP_ALLOW_PRIVATE_ENDPOINT=true` to allow them for every user, or serve the models to everyone with `RAKAZO_LOCAL_MODELS`.
- A bot asks before fetching a site that it was not given in the run. This includes routines. Choose **Always allow** on the approval card or turn on Auto Review. Webhook runs refuse such sites.
- The web app sends a strict Content-Security-Policy, which blocks scripts that a CDN or proxy injects. Search the API logs for `csp.violation` and add the origins with `RAKAZO_CSP_SCRIPT_SRC` and `RAKAZO_CSP_CONNECT_SRC`.
- Mobile app users need to sign in again once.

## [0.3.0] - 2026-10-20

### Added

- Self-hosted deployments can run multiple Telegram bots, for example one per space, using `TELEGRAM_BOT_TOKEN_<NAME>` and `TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>` pairs.
- Railway computers can start in a chosen region. Set `RAILWAY_SANDBOX_REGION` to keep them near the API instead of Railway's default region, so each command, click, and screenshot avoids a cross-region round trip. Unset, nothing changes.
- A ```mermaid block in a bot's message is drawn as a diagram, on the web, in the desktop app and on mobile, in the app's light or dark palette. Source Mermaid cannot draw stays a code block, and a block the bot is still writing reads as code until it is complete. On the web, Mermaid loads only when a message contains a diagram, and a diagram's source can be copied. The mobile app draws diagrams with Mermaid served by your own server (`/api/v1/assets/mermaid.js`), so an older server keeps showing code blocks.

### Fixed

- A Railway computer whose sandbox had been destroyed could not start again: it failed with "Railway live screen requires PRIVATE networking" instead of creating a new sandbox, because Railway no longer reports networking for a destroyed sandbox. It now starts a new sandbox and restores the portable home.
- The Amazon Bedrock model picker was missing newer models available on Bedrock: Claude Sonnet 5.5, GPT-6 Luna, GPT-6 Sol and GPT-6.1 Sol, Grok 4.7, Kimi K3, GLM-5.3, and the India (`in.`) Claude inference profiles. They are now listed with their regional and global inference profiles until the bundled provider library ships them.

## [0.2.0] - 2026-10-11

### Added

- A routine can run on its own model and thinking level, picked in the routine editor. Left on the bot's model, nothing changes. A run keeps the model chosen when it was created, so editing the routine afterwards cannot move a waiting run, and a later resume does not treat the model an attempt recorded as that choice. Webhook, GitHub, and message deliveries use a routine model when every routine in that delivery chose the same one, including when the delivery has to wait for the bot to finish.
- The deployment-wide default model can run on Amazon Bedrock without a key. With `PI_DEFAULT_CREDENTIALS=host`, `PI_DEFAULT_PROVIDER=amazon-bedrock` and `PI_DEFAULT_MODEL` set, a deployment whose host has an AWS role (an ECS task, IRSA or EC2 instance role) counts as having a default model, and runs use those credentials instead of a stored Bedrock API key.

### Changed

- Message bubbles in the web/PWA transcript use more of a wide window's width (70%/74% caps raised to 84%/88%, still leaving room for the hover-actions gutter), instead of leaving a quarter to a third of a long message's row empty.
- Every run's system instructions now state the current date and time (UTC), so bots judge deadlines, recency and scheduling from the real present instead of guessing it from training data or quoted timestamps.

### Fixed

- Fish Audio speech can use a model other than s2.1-pro. Each Fish connection can set Speech model in Voice settings; `FISH_TTS_MODEL` is the default only when that field is empty (unset still uses s2.1-pro). A failed speak, transcribe, or voice-list request logs the upstream Fish status and message, including when the error body cannot be read, and the message returned to the client does not include the API key.
- A picture attached to an earlier message is now visible to the bot when a later turn asks about it, for a model that can see images. Only the current turn carried its images; older turns arrived as a text marker, so the bot asked for the picture again. The most recent user turns now keep their images, within a fixed turn, byte, and per-model image budget. A turn whose pictures exceed the byte budget keeps the newest ones that fit. If an earlier picture cannot be read, its history marker says it is unavailable.
- A bot on a reasoning model could answer with "No response. Try again." on a harder question: thinking is billed against the same output ceiling as the reply, and the 4k default left nothing for the reply itself. Reasoning models now get a 32k output ceiling instead, still bounded by whatever the model itself allows.
- A newly created bot's thread opened empty and stayed silent until given real work, so a misread `title`/`description`/`instructions` went unnoticed until it cost a run. Creating a bot now queues one turn where it states how it understood its role and asks for anything it needs.
- A message sent while that introduction was still running was answered by the intro, which cannot use tools. The message now waits until the introduction finishes and is answered in the following turn, and the introduction does not send a finish notification. A reply to a message from a linked chat app still goes back to that app. Messages held from different chats, such as a group channel and a direct chat, are answered in separate turns.
- A message sent while one of the bot's routines (or an inbound webhook) was running in the same thread was folded into that turn as steering, so the bot answered without the conversation ("I have no earlier context"). The message now waits until that turn finishes and is answered in its own turn with the full thread. A composer reply while that run is already waiting for input still answers the ask, unless a live conversational run is active to take the message.
- Every turn failed on Claude models through Amazon Bedrock with "input_schema does not support oneOf, allOf, or anyOf at the top level": `request_secret` declares its two destinations as a root `oneOf`, and Anthropic rejects the whole request for it. Root unions in tool schemas, including ones from MCP servers, are now merged into a single object schema before they reach a provider; the executor still enforces credential or `connectionId`, not both.
- Pipedream exposed every tool of every connected app at once, so a handful of apps could fill a run's tool list. Above 20 tools the connector now offers the same lazy catalog the MCP connector uses (`pipedream_search_tools`, `pipedream_load_tool`, and `pipedream_execute_tool`), with names grouped by app.
- The Needs you computer card in a thread now includes Open, which opens that bot's computer the same way the computer panel does, including from a group member bot.
- Bots with more than 20 MCP tools failed on every Claude model behind a Claude Pro/Max/Team sign-in with "You're out of extra usage": Anthropic rejects Claude Code OAuth requests that carry a tool named `mcp_*`. The lazy catalog wrappers are now `connectors_search_tools`, `connectors_load_tool` and `connectors_execute_tool`.
- Changing a bot's model, thinking level or voice failed with a validation error once its instructions outgrew the description limit, and saving any other setting overwrote those instructions with the shorter description text. Bot settings now put the description and instructions on the wire only when that field was edited, clamped to each field's own limit.

## [0.1.2] - 2026-09-06

### Added

- Desktop owners using Docker can opt into running bot shell commands directly on their computer. This grants access under the owner's OS account; see [computer providers](docs/self-host-sandbox-providers.md#choosing-a-provider).

### Changed

- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.

### Messaging upgrade notes

- Webhooks use `/api/v1/messaging/webhook/<provider>`; the previous Sendblue path remains supported.
- Configure credentials for each messaging provider in `.env`; see [.env.example](.env.example).
- Unknown senders are ignored by default. `MESSAGING_OPEN_SIGNUP=true` restores automatic account
  creation from incoming messages and requires a deployment model key.

## [0.1.0] - 2026-09-03

### Added

- Voice mode: spoken replies, hold-to-talk dictation, and half-duplex calls with ElevenLabs, OpenAI, Cartesia, or Fish Audio.
- GitHub Copilot and SuperGrok / X Premium sign-in for model access.
- Spawn peer bots (each with its own thread and computer) and short-lived in-thread subagents.
- ChatGPT Plus or Pro sign-in for model access.
- Mobile: point the app at a self-hosted API origin, a native iOS inbox, and take control of the live desktop.
- Provider-neutral integrations: managed apps through Composio or Pipedream Connect, plus encrypted user-installed Treg, HTTPS MCP, and OpenAPI tool sources on web and mobile.
- Disconnect connected Composio plugins.
- Routines in plain language instead of raw cron.

### Changed

- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Removed

- Nonfunctional Grant folder picker in the desktop app.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
