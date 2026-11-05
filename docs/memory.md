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
- **Honcho**: reads from an existing Honcho peer and never writes to it.
- **Self-hosted**: connect your own Memmy Memory service using its **Server URL** and **Bearer token**.
  Eligible owner conversations are recalled before each turn and captured after successful completion.
  Short replies can borrow a bounded, redacted tail of the preceding reply from the same bot.
  The service can distil that evidence into procedures for later recall. Choose the summary,
  evolution and embedding models in the service's own settings; Rakazo does not select or replace them.
  Completion freezes already-redacted evidence in the same transaction as the final reply, using
  the turn's in-memory redactions and the configured content-encryption policy. Turns with temporary
  run-only credentials or one-time codes remain excluded. Older pending turns, including snapshots
  frozen under the previous background-redaction contract, are skipped rather than assumed safe or
  rebuilt using today's credentials. The versioned target keeps new snapshots stable across later
  credential rotation; this upgrade intentionally retires the older pending delivery contract.

The Server URL is reached by the Rakazo API and worker, not by the browser. If those run in
containers, `127.0.0.1` points at that container. Use an endpoint reachable from both services;
private endpoints require the operator's existing `MCP_ALLOW_PRIVATE_ENDPOINT` permission. Keep
service tokens out of URLs and use the encrypted credential field. Capture freezes a non-secret
connection identity when the turn completes. If the configured service/owner changes before delivery,
the old turn is not forwarded to the replacement connection; captures with an unknown older identity
are also skipped. Credential rotation for the same connection does not change its identity.

Authentication or missing-route errors preserve pending snapshots and trigger a connection-level,
PostgreSQL-backed cooldown: one minute initially, increasing up to one hour. Workers share a bounded
probe lease, so restarting a worker does not reset that cooldown. Updating the connection credentials
allows another probe immediately. Recovery scans advance across pending conversations instead of
repeatedly selecting only the oldest page. Clearing a conversation removes its pending snapshots;
it cannot retract content an external service has already accepted.

**Memmy isolation:** its source/profile labels are not an authorization boundary. Bots and spaces
connected to the same Memmy database can retrieve each other's derived memories, regardless of the
scope labels sent by Rakazo. Use a separate service/database and token for each private trust domain;
only connect multiple bots to one instance when sharing is intentional. The scope picker controls
namespace mapping, not isolation enforced by this adapter.

Once connected, **Default scope** decides what bots share in providers that enforce that scope:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Rakazo's memory notes never cross [spaces](./spaces.md). External memory providers must enforce
that boundary independently. Do not reuse a Memmy service/database between private spaces; see its
isolation limitation above.
