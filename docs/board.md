# Ticket board

> [!NOTE]
> The ticket board is a Labs feature. Each account turns it on in **Settings → Labs**, or a
> self-hosted server turns it on for everyone with `TICKET_BOARD_ENABLED=true` on the API and
> worker. See [Configuration](./self-host-configuration.md).

The board is a shared list of tickets that you and your bots both work from. Open it from **Board**
in the account menu, or from **Board** in Settings on mobile.

Tickets move through **To do**, **In progress**, **In review**, **Blocked**, **Done** and
**Won't do**. Each has a title, description, owner, priority and comments.

Assign a ticket to a bot and it starts working on it. Bots can also create, update and comment on
tickets themselves. Ticket work stays out of your chats, but a bot that needs you still posts a
card in its chat.
