# Bots and chats

Each bot is a teammate with one continuous chat, its own instructions and memory, and a computer to
work on.

## Create a bot

Your first bot is created for you when you sign up. To add another, choose **Create** (the **+** at
the top of the sidebar), then **New bot**. Give it a name and choose **Create**.

Then tell it its job in the chat, in plain words. It asks for anything else it needs, such as a
sign-in or an app to connect.

> [!TIP]
> One bot per job works best: an inbox bot, a research bot, a bot for one client. Each keeps its own
> history and memory, so it gets better at that job over time.

### Start from a template

**Bot templates** are ready-made bots for common jobs: a morning briefing, inbox triage, pull
request reviews, and a weekly digest of topics you follow. Open them with **Templates** in
**Connect apps** or **Skills**. Each template shows an example of what the bot sends and everything it adds before you
choose **Create bot**.

A template adds the bot's instructions, a skill to your library, and a routine that stays paused
until you turn it on. Nothing is connected for you: the new chat asks for the apps the bot works
with, and it still works without them where it can. Creating the same template again opens the bot
you already made.

## Talk to it

Type in the composer and press Enter. You can keep chatting while a bot works, and **Stop** ends
the current run.

- **Attach file** adds files and images. If the bot's model can't read images, you can still
  send the picture as a file for the bot to work with.
- Type **@** to mention another bot, a group, a routine or a connected app.
- Type **/** at the start of a message to use a [skill](./skills.md).
- Hover a message to **React**, **Reply** or **Copy**. Select text in a reply to quote just that
  part.
- Hold the microphone to talk instead of typing. See [Voice and calls](./voice-and-calls.md).

Bots reply with formatted text, tables, charts, files and [pages](./pages.md). Files they send open
in a preview and can be downloaded. Every file a bot has sent is also listed under **Artifacts** in
the account menu. Bots can find files you sent them long ago, so "the lease I sent you" works
without sending it again.

When something is left open until a known time ("I'll send the contract on Friday"), the bot may
set itself a follow-up for then. It stays quiet if the item is already done.

When a bot needs something from you, it posts a card in the chat: a question, an
[approval](./approvals.md), or a request to take over its screen. Cards never block the chat; you
can answer later.

## Bot settings

Click the bot's name at the top of the chat to open its settings.

- **Name** and avatar: pick a shape and color, or upload an image.
- **Notifications**: **When it finishes or needs input**.
- **Open work**: the to-do list the bot keeps for itself. You can add, complete or remove items.
- **Memory**: what the bot has written down. See [Memory](./memory.md).

Under **Advanced**:

- **Model** and **Thinking**: override the [model](./models.md) for this bot.
- **Computer**: **Team** or **Private**. See [The bot's computer](./computer.md).
- **Voice**: **Read replies aloud** and the bot's voice.
- **Permissions**: **Allow cross-space bot communication** and
  [**Manage other bots**](./fleet-management.md).
- **Instructions**: the bot's standing instructions. You can also ask the bot in chat to change
  them, or its name, model, thinking, voice and read-aloud; instruction and setting changes
  show **Undo** in the chat. Memory scope stays in Settings, since shared memory changes what the bot can read.
  **Instruction history** lets you restore an earlier version.
- **How other bots see it**: a short description other bots read when deciding whom to ask.
- **Tools**: **Disable a tool** the bot should never use.
- **Export** downloads the bot's setup as a file. **Clear conversation** empties the chat.

## Organize the sidebar

Right-click a bot in the sidebar to **Pin** it, **Move to** a section, **Mark as Unread**,
**Duplicate**, **Archive** or **Delete** it. Archived bots can be restored later.

## Find things

- **Search** in the sidebar searches bots and conversations. Press Cmd+K (Ctrl+K on Windows and
  Linux) to jump to any bot.
- **Activity** in the sidebar lists every run, with filters for status and date. Use it to find a
  run that failed or is waiting on you.
- **Artifacts** in the account menu lists every file bots have made, with search and a date filter.
