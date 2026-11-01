# Chat apps

Message your bots from Slack, Telegram, WhatsApp, iMessage or SMS, and add them to group chats
there.

> [!NOTE]
> **Settings → Messaging** appears only when your server has at least one chat app set up. Which
> apps you see depends on the server: Slack, Telegram, WhatsApp, iMessage and SMS, and Feishu (Lark)
> are supported. On a self-hosted server the operator configures them; see
> [Self-hosting](./self-host.md).

## Link a bot to a chat app

1. Open **Settings → Messaging**.
2. Pick the bot, then choose the app under **Connect a chat app**.
3. Send the code shown from that app within 10 minutes.

From then on, messages you send there go to that bot's chat, and its replies come back to you there.
The conversation is the same one you see in the Rakazo app.

To stop, choose **Unlink**.

## Slack

Choose **Connect** next to Slack to add Rakazo to your Slack workspace, then **Link DMs** so direct
messages reach your bot.

A [routine](./routines.md) can also start from a **Slack message**.

## Group chats

Add your bot to a group or channel in the chat app. The invite appears under **Requests** in
**Settings → Messaging**; choose **Approve** or **Decline**. Approved groups are listed under
**Conversations**, where you can **Leave** one at any time.

Open a conversation's **Settings** to decide how the bot behaves there:

- **Listening**: **Listen** to everything, or **Mentions only**. Either way, the bot answers when
  mentioned directly.
- **Room guidance**: plain-language rules for the room, such as "Engage when someone asks about
  invoices. Ignore small talk."
- **Automated senders**: for each bot or integration that posts in the room, choose **Ignore**,
  **Group updates** into a periodic digest, **Always act**, or **Treat like a person**.
