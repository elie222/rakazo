# Import an OpenClaw, Hermes or ChatGPT agent

Moving from OpenClaw, Hermes Agent or another assistant such as ChatGPT or Claude? Rakazo can turn
it into a new bot, with its instructions, memory and skills, next to the bots you already have.

Open **Settings → General** and choose **Import an agent**. Import is available in the web app
and the desktop app.

## From OpenClaw or Hermes

Choose either:

- **Choose folder**: the agent's home folder, such as `~/.openclaw` or `~/.hermes`.
- **Choose backup**: a `.zip` or `.tar.gz` backup of that folder.

The folder or backup is read on your device. Only the files the import uses are sent, and
`.env` and `auth.json` are read only if you tick **Include API keys**.

## From another assistant

For ChatGPT, Claude, Gemini or any other assistant:

1. Choose **Copy prompt** and send the prompt to your old assistant. It asks it to write down its
   name, instructions, what it remembers about you, and the procedures it follows.
2. Paste its reply and choose **Continue**, or choose **Choose file** if it gave you a `.md` file.

## Choose what comes along

Before anything is created, you see every item the import found and tick what to keep:

| Item | Becomes |
| --- | --- |
| Instructions (`SOUL.md`, `AGENTS.md`, …) | The new bot's instructions |
| Memory (`MEMORY.md`, `USER.md`, daily notes) | The bot's memory, or memory shared by all your bots |
| Skills | Skills in the library all your bots share |
| Model | The bot's model, when you have that provider connected or import its key |
| MCP servers | MCP servers the bot asks before using |
| Scheduled jobs | Routines, paused until you turn them on |
| API keys | Model connections, only when you tick **Include API keys** |

Anything that runs code or acts on its own (skills, MCP servers, routines) starts unticked, as do
untouched defaults the old agent wrote and text that looks like it contains a key. **Not
imported** lists what was left out and why, such as files only the old runtime uses.

## After the import

The new bot opens with a checklist of anything that still needs you, such as a credential an MCP
server needs or a paused routine. Each item links to where you finish it. Your other bots,
including Chief, are not changed.
