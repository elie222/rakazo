# The bot's computer

Every bot has a real computer with a browser, a terminal, files and a desktop, so it can do work
that needs more than a chat.

## Watch it work

Choose **Agent computer** at the top of the chat to open the bot's screen beside the conversation.
Choose **Open in full window** for a larger view. The computer starts when a bot needs it and goes
to sleep when idle; opening it wakes it.

On mobile, open the bot's profile and choose **Open computer**.

## Take control

Choose **Take control** to use the screen yourself, for example to sign in to a site. The header
shows **You have control** until you choose **Release control** (**Release** on mobile).

When the bot hits something only you can do, such as a CAPTCHA or a code texted to your phone, it
asks you to take over. The header shows **Needs you**. Do the step, then choose **I’m done**, or
**Skip** to let the bot carry on without it.

> [!TIP]
> Want the bot to sign in by itself next time? Ask it to save the login. See
> [Reusable credentials](./bot-secrets.md).

## Team or Private

In the bot's settings under **Advanced**, **Computer** is **Team** or **Private**.

- **Team** (the default): bots in the [space](./spaces.md) share one Team Computer, with the same
  files and installed tools. Each bot gets its own screen and browser, and sites you sign in to are
  carried over to the other bots.
- **Private**: the bot gets a computer of its own. Use it when files or sign-ins must not be shared
  with other bots.

## Files

Bots save their work on the computer and send you the results as files in the chat. Every file a bot
has sent is also under **Artifacts** in the account menu.

To have a bot react to files changing, use a [routine](./routines.md) that watches a folder.

## Fix a computer

Open the computer and choose **More computer actions**:

- **Stop computer**: shut it down now. It starts again when needed.
- **Update computer**: save the workspace and install current software.
- **Recover computer**: recreate a computer that is not working.
- **Reset computer**: go back to the last saved workspace. Unsaved work on the computer is lost.

## Use your own computer

In the [desktop app](./desktop-app.md), bots can also run commands on the computer the app is
installed on. Turn on **Let bots use this computer** in **Settings → General** under **Computers**.
In every [approval mode](./approvals.md), a bot asks before its first command in a space and before
it first uses each app there, unless a Block rule refuses it. **Allow in this space** covers the
rest of that space, in any chat, until you remove the computer from the same list.

> [!WARNING]
> A bot with access to your computer can read your files and run programs as you. Only turn it on
> for a computer you would let your bots use unattended.
