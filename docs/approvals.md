# Approvals

Decide how much a bot can do without asking you first.

## Choose a mode

Open **Settings → Approvals** and pick a **Mode**:

- **Ask**: the bot asks before any action that changes something, such as sending an email or
  editing a document. Reading usually doesn't ask. Saving to memory asks first once the run's
  permissions are reduced: after it reads outside content (including what `recall_memory` or
  `reflect_memory` returns), when it resumes after a pause, and in runs that didn't start from your
  message in Rakazo, such as routines, webhooks, bot messages and chat-app messages. Memory the bot
  recalls automatically, its notes and chat history don't make it ask.
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

In **Auto** and **Ask**, these always show a card, and **Always allow** doesn't skip it:

- Changing a bot's instructions or model, and creating a space.
- A routine that watches a command, or that names a site the run found in outside content.

**Never ask** runs all of them. The one exception is accepting another owner's bot connection, which
it refuses when someone else started the run or outside content entered it.

## Spending limit

Once a bot can pay, with a card in the Vault or a connected wallet, **Settings → Approvals** also
shows a **Spending limit**: an amount, in US dollars, euros, pounds or shekels, that resets every
day, week or month, or never. Days and months follow your timezone; weeks start on Monday. It
covers every bot and space on your account, and only you can change it.

Every payment you approve counts against it: a checkout's pay button at the total the page shows,
or the amount the button names if that is more, and a wallet purchase at its exact amount. A pay button counts when the bot's page browser recognizes
it as paying, the same presses that always ask; on a computer without the page browser, nothing is
recognized, so only wallet purchases count. A payment that would go over the limit is refused before
you are asked, and the bot tells you. While a limit is set, a checkout whose total can't be read, or
is in another currency, is refused too. A wallet purchase that is denied, expires or fails stops
counting, and so does a press the page refused because it changed. A press that went through still
counts if the shop later declines it.

When the page browser can identify the clicked control, it treats explicitly marked,
non-submitting payment-method tabs and radio options as selectors, not pay buttons.
The final payment button still asks separately.

Below the limit, **Recent payments** lists the latest payments that count, with the site, the bot,
when and how much, whether or not a limit is set.

A page in another dollar or pound currency is counted as if it were in US dollars or pounds. That
is more than it costs for nearly all of them; a Cayman Islands dollar is worth a little more than a US
dollar, so a price in it counts a little less. A saved card pays whatever the shop charges, so the limit relies on
the total the page shows; only a wallet's single-use card holds the shop to the approved amount.

## Per space

Approval settings are account defaults that every [space](./spaces.md) follows. To give one space
different rules, open its settings and choose **Customize** next to **Approvals**.
