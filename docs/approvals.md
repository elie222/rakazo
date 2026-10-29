# Approvals

Decide how much a bot can do without asking you first.

## Choose a mode

Open **Settings → Approvals** and pick a **Mode**:

- **Ask**: the bot asks before any action that changes something, such as sending an email or
  editing a document. Reading usually doesn't ask.
- **Auto**: an approval model checks each action against what you asked for. Actions that fit go
  ahead; the bot asks when one is off-task, or can't be undone and you didn't ask for it.
- **Never ask**: every action runs without waiting.

**Auto** needs an **Approval model**, set in **Settings → Models**. See [Models](./models.md).

> [!TIP]
> Start with **Ask** or **Auto**. As you approve the same action again and again, choose
> **Always allow** on the card and the bot stops asking for that one.

## Approval cards

When a bot needs a yes, it posts a card in the chat showing exactly what it wants to do:

- **Allow once**: just this time.
- **Always allow this tool**, or **Always allow** a site: stop asking for it.
- **Deny**: the bot doesn't do it and carries on.

Cards never block the chat. Keep talking to the bot, and answer the card whenever you're ready. You
get a notification when a bot is waiting on you, if notifications are on in the bot's settings.

## Allow and Block lists

Every **Always allow** choice is saved in **Settings → Approvals**. Switch any entry between
**Allow** and **Block**, or **Remove** it. A blocked action is refused without a card, in every
mode. **Preview** shows what would happen for a given tool before you change anything.

To stop one bot from ever using a tool, open the bot's settings, expand **Advanced**, and use
**Disable a tool** under **Tools**.

## What always asks

- Changing a bot's instructions, creating a space, and the actions in
  [Bots that manage bots](./fleet-management.md) always show a card. **Auto** and **Always allow**
  don't skip it.
- Actions that text you didn't write could be steering, such as changes in a run started by a
  webhook, ask in **Auto** and **Ask**, and are refused in **Never ask**.

## Per space

Approval settings are account defaults that every [space](./spaces.md) follows. To give one space
different rules, open its settings and choose **Customize** next to **Approvals**.
