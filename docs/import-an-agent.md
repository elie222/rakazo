# Import an OpenClaw, Hermes, Grok Bot or ChatGPT agent

Moving from OpenClaw, Hermes Agent, Grok Bot or another assistant such as ChatGPT or Claude? Rakazo
can turn it into a new bot, with its instructions, memory and skills, next to the bots you already
have.

Open **Settings → General** and choose **Import an agent**, then pick where the agent comes from.
Your first bot's opening question also offers **Move from another assistant**, which opens it.
Import is available in the web app and the desktop app.

## From OpenClaw or Hermes

Pick **OpenClaw** or **Hermes**, then choose either:

- **Choose folder**: the agent's home folder, such as `~/.openclaw` or `~/.hermes`.
- **Choose backup**: a `.zip` or `.tar.gz` backup of that folder.

The folder or backup is read on your device. Only the files the import uses are sent, and
`.env` and `auth.json` are read only if you tick **Include API keys**.

## From Grok Bot

Grok Bot has no export button, so each Bot writes down its own setup:

1. Pick **Grok Bot**, choose **Copy prompt** and send it to the Bot in Grok Bot. It asks the Bot to
   write its instructions, memory, skills, routines and connected apps as a `grok-bot-export` JSON
   file, without changing anything or including passwords or keys.
2. Paste the Bot's whole reply and choose **Continue**, or choose **Choose file** for the file it
   made. A Bot that split its export into several parts: paste or choose all of them together.
   When one reply holds several Bots, pick the one to import; import each Bot separately.

Exports written for Hermes Agent's or OpenMausBot's Grok Bot importers use the same format and
import here too.

Routines come over paused, on the matching trigger:

| Grok Bot trigger                   | Becomes                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| Schedule                           | The same schedule                                                   |
| Webhook, Linear, Sentry, PagerDuty | A webhook trigger                                                   |
| GitHub                             | A Git event trigger                                                 |
| Slack                              | A Slack message trigger, when this server has Slack                 |
| Email                              | An email trigger for mail from you, when this server receives email |

Turn each one off in Grok Bot before you turn it on here, so it doesn't run twice. Point a
webhook or Git routine's source at the address its trigger shows here. Give the bot an email
address before an email routine can run, and connect it to Slack before a Slack routine can. An
event routine's prompt starts with its original trigger and details, such as the channel or
repository, so the bot knows what it was for.

Routines whose schedule could not be read, or whose event this server does not receive, are
handed to the new bot: its chat opens with them, with their trigger and full instruction, along
with the apps to connect again. Tell the bot which ones to set up; nothing runs until you do, and
nothing is added to its memory for them. Connected apps with a remote MCP address become MCP
servers you sign in to again. Chats, files on the
Bot's computer and sign-ins stay in Grok Bot.

## From another assistant

For ChatGPT, Claude, Gemini or any other assistant:

1. Pick **Another assistant**, choose **Copy prompt** and send the prompt to your old assistant. It asks it to write down its
   name, instructions, what it remembers about you, and the procedures it follows.
2. Paste its reply and choose **Continue**, or choose **Choose file** if it gave you a `.md` file.

## Choose what comes along

Before anything is created, you name the bot and see what the import found, one row per kind of
item. Everything is ticked to start with; open a row to read its items and untick what you do
not want:

| Item                                         | Becomes                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Instructions (`SOUL.md`, `AGENTS.md`, …)     | The new bot's instructions                                               |
| Memory (`MEMORY.md`, `USER.md`, daily notes) | The bot's memory, or memory shared by all your bots                      |
| Skills                                       | Skills in the library all your bots share                                |
| Model                                        | The bot's model, when you have that provider connected or import its key |
| MCP servers                                  | MCP servers the bot asks before using                                    |
| Scheduled jobs and Grok Bot routines         | Routines, paused until you turn them on                                  |
| API keys                                     | Model connections, only when you tick **Include API keys**               |

Routines arrive paused, and the bot asks before it uses an MCP server. A skill that carries
code or files, untouched defaults the old agent wrote, and text that looks like it contains a key
start unticked. **Not
imported** lists what was left out and why, such as files only the old runtime uses.

## After the import

The new bot opens with a checklist of anything that still needs you, such as a credential an MCP
server needs or a paused routine. Each item links to where you finish it. Your other bots,
including Chief, are not changed.
