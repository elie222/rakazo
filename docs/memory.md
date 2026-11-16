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
  Shared scope, bots also share one memory for the Space, including learned direct-chat turns.
  Bots learn from their conversations (their
  own chats, group chats, and messages between bots) unless you turn off **Learn from
  conversations**. Learning uses bounded excerpts from recent human messages and replies,
  for both direct and group chats. Saves and conversation submissions share a thirty-second budget
  across DNS and both banks. Failed submissions retry with stable operation IDs, while cleanup
  remains active for partially accepted writes. Each cleanup attempt has a ten-second deadline and deletes per-turn documents
  in bounded parallel batches. Failed cleanup is retried up to twelve times through the existing
  queue, using the captured connection identity. Cleanup remains best effort if publication fails
  or the process stops before the retry is queued. If the configured connection cannot be loaded,
  cleanup cannot capture a safe retry identity either. Outages or writes pending beyond the polling
  window can leave gaps or stale memories. If a submission response is uncertain, cleanup checks
  continue through the bounded window. Unchanged conversations require only a local generation
  check without resolving credentials; a later refusal cannot prove an earlier attempt stored
  nothing. Disconnecting or changing
  the connection stops cleanup on the old service; it does not delete data there. Bots can't forget a
  single memory here. Deleting a bot with its memories removes that bot's retained conversation
  sessions, including groups it left. Other bots' independently learned copies remain.
  To let bots read memories another app keeps in the same Hindsight, list its banks
  under **Recall from banks**; bots read those banks only through explicit recall, never automatic context, and never write to them. Names beginning with
  `rakazo-` are reserved for Space isolation and cannot be imported. Bots can also ask
  their own bot memory to answer a question by combining what it knows; reflection does not query
  the Space's shared bank. Shared facts remain available through recall. Summaries of long chats stay in
  Rakazo: Hindsight learns from the conversation itself, not from summaries of it.

To change a connected provider's settings, choose **Edit**. You only need to enter the key again
when you change where it connects or what it can read.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

### Knowledge provenance (version 1)

Learning and instruction authority are separate. A bot may learn from people, other bots and
outside-derived replies in a conversation it can access. That knowledge stays in the receiving
Space's private or deliberately shared memory. Learning does not grant access to another Space.

The source policy is deliberately conservative:

- Every bot message, old reply, summary and recalled memory is derived data. Reusing it never
  certifies that its source was clean or makes it an owner instruction.
- Conversation learning preserves speakers' names, and recall keeps provider attribution when
  available. These identify sources; they do not grant authority or certify factual correctness.
- Semantic recall and reflection remain derived even when the bank belongs to the same bot or
  the provider omits its optional outside-bank attribution.
- Automatic recall includes only bot-owned and deliberately shared Space banks. Imported banks require explicit recall and its fresh-input action protections.
- Stored history and automatic recall do not change current owner permissions. Fresh outside
  input, including explicit semantic recall and reflection, keeps existing action protections.

There is no per-run clean flag or ancestry graph. This avoids both claiming that old replies can
attest a clean source and making ordinary work wait on provenance bookkeeping. Cross-bot learning
remains enabled, and sharing knowledge never bypasses the receiving Space's access checks.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.
