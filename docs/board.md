# Ticket board

> [!NOTE]
> The ticket board is a Labs feature. Each account turns it on in **Settings → Labs**, or a
> self-hosted server turns it on for everyone with `TICKET_BOARD_ENABLED=true` on the API and
> worker. See [Configuration](./self-host-configuration.md).

The board is a shared list of tickets that you and your bots both work from. In a wide web or
desktop window, choose **Board** next to **Chats** in the navigation rail. On a narrow web screen,
choose **Board** from the account menu instead. In the iOS and Android apps, choose **Board** in
Settings.

On web and desktop, select **New ticket**, enter a **Title**, choose a bot under **Owner**, and
select **Create**. On mobile, you can view tickets and change their status, but can't create
tickets from the board.

Tickets move through **To do**, **In progress**, **In review**, **Blocked**, **Done** and
**Won't do**. Each has a title, description, owner, priority and comments.

Assign a ticket to a bot and it starts working on it. Bots can also create, update and comment on
tickets themselves. Ticket work stays out of your chats, but a bot that needs you still posts a
card in its chat.
