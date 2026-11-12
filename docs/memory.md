# Memory

Bots remember what matters between conversations, and you can read, download or delete anything they
keep.

## What a bot remembers

Each bot writes notes as it works: your preferences, facts about the job, what it tried. Its notes are
indexed in a file called `MEMORY.md`.

You can also just tell it: "remember that invoices go to the finance folder".

A bot keeps its notes short, one fact per line. When something changes, it rewrites the old note
instead of adding a second one, and it deletes notes that no longer hold. It keeps at most 4 KB of
notes in `MEMORY.md`, merging or removing notes to make room. You can still add more by hand.

To see what a bot remembers, click its name at the top of the chat and open **Memory**. Each note can
be edited, downloaded or deleted. In the mobile app, the notes are in the bot's chat settings, where
you can edit or delete them.

## Shared memory

Some things every bot should know, such as your name, your company, or how you like reports
written. Those go in **Shared memory**: every bot in the [space](./spaces.md) reads these notes and
keeps them up to date.

Find it in **Settings → Memory**, on the web, desktop and mobile apps.

## Memory providers

Optionally, connect a memory service so bots can also recall facts by meaning, not just by reading
their notes. In **Settings → Memory**, choose **Connect memory provider**:

- **Supermemory**: its cloud service, or your own instance.
- **Serenity**: choose **Recall and write**, or **Recall only** to keep it read-only.
- **Honcho**: saves and recalls facts using Rakazo’s own peers. Optionally, enter a workspace
  and **User peer** to also recall what Honcho already knows about you. That existing peer stays
  read-only; Rakazo writes new facts to its own peers in the same workspace.
- **Hindsight**: its cloud service, or your own server. Each bot keeps its own memory; with the
  Shared scope, bots also share one memory for the Space. Bots learn from their conversations (their
  own chats, group chats, and messages between bots) unless you turn off **Learn from
  conversations**; clearing a chat removes what was learned from it. Bots can't forget a single
  memory here. To let bots read memories another app keeps in the same Hindsight, list its banks
  under **Recall from banks**; bots read those banks but never write to them. Bots can also ask
  their memory to answer a question by combining what it knows. Summaries of long chats stay in
  Rakazo: Hindsight learns from the conversation itself, not from summaries of it.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.
