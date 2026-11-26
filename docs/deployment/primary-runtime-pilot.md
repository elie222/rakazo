# Primary runtime pilot

Off by default. It changes only the selected bot owner's plain-text app direct
chat. A pilot turn uses the configured named API-key connection and model as of
enqueue; it never uses the deployment/default key or falls back to another
engine. Connections remain controlled by existing bot settings. Ordinary Pi turns are unchanged unless a separate pilot entry point is explicitly enabled. No provider
login, tools, shared workspace, media, steering or native conversation state
are available in a pilot turn.

## Staging gate

1. Apply the additive migration. Upgrade **all** API replicas and recovery
   workers and drain every older process before setting any pilot variables.
   Older processes do not understand the engine marker and must not claim
   those runs. Mixed versions are safe only while the pilot stays disabled.
2. Provide a trusted Linux isolation launcher. Set
   `PRIMARY_RUNTIME_PILOT_LAUNCHER` to its absolute path on every API and
   worker. Rakazo supplies the pinned executable and its arguments as separate
   argv entries with stdin/stdout pipes, limited environment, and a fresh
   per-turn working directory. The launcher must not run through a shell or
   allow execution on the application host if isolation setup fails. It must
   restrict filesystem access to immutable runtime files and private per-turn
   scratch, deny host mounts and sockets, bound resources and process
   descendants, and allow egress only to the authorized fixed API endpoint.
   Termination must also stop descendants. No launcher is provided by this PR.
3. Validate those properties on the intended staging host, not just with the
   offline process fixture. Verify the actual named connection, cancellation,
   database recovery, and absent/missing launcher behavior. Do not set the
   pilot allowlist until that check passes.
4. The bot owner selects the supported direct API provider/model and a named
   API-key connection in bot settings. An operator may then set
   `PRIMARY_RUNTIME_PILOT_BOT_IDS` to the same comma-separated bot IDs across
   API and workers. Start with one dedicated test bot. Prefer a personal
   space and do not rely on unsupported turn types to run through the pilot.

## Recurring text routine pilot

Default off. Keep the staging gate above. An operator and bot owner may approve
one or more dedicated recurring routines in the owner's bot chat. Set
`PRIMARY_RUNTIME_PILOT_ROUTINES` to comma-separated
`<routine-id>:<sha256-of-exact-stored-UTF-8-prompt>` entries on all workers.
Approve the raw prompt, not its rendered text. A prompt edit needs a new digest;
do not put the prompt itself, a key, or a shared account in this setting.

Only automatic recurring timer occurrences use this path. The routine must be
active and use its owner's bot's model, with no group, watch, inbound trigger,
computer access or separate model override. Run now, retries and one-time
routines are not supported by this pilot. The provider receives only the approved
text, with secret redaction, no tools, history, skills, or native session.
An ineligible enrolled timer is skipped with an operator warning, not run through
Pi. The worker rechecks the active routine, exact prompt, space membership,
ownership, and named model connection before launch. If the account becomes
unavailable, the marked run fails without falling back.

Before enabling, verify a real scheduler occurrence in staging, a repeated
delivery of the same occurrence, and refusal after disabling the routine or
revoking the connection. Clear this setting after draining/cancelling marked
runs to restore ordinary Pi handling for future timer occurrences.

## Owner-directed outbound group handoff

Default off. List both bots in `PRIMARY_RUNTIME_PILOT_OUTBOUND_BOT_IDS`
on the workers. Both must be enabled for owner mentions and the recipient
must also be enabled for inbound pilot handoffs. They must belong to the
same app group and the same active owner. Mention the source bot with
the composer at the start of the first line, then type `/handoff Recipient Name`
after the space inserted by the composer.
On the next line, write the task brief or ask the source bot to draft it.

The source gets only that text, with no history or tools. The complete
draft is sent once to the selected recipient, using only the recipient's
pinned connection. A stopped or failed draft publishes nothing. Model
output cannot pick a recipient. The receiver cannot hand off again, and no
ordinary runtime, files, memory, or computer access is inherited. Do not
enable this slice until the separately documented staging gate passes.

## Native text resume contract (not enabled in the application)

The adapter can snapshot a complete native text turn and restore the exact
session in a fresh process. It validates the selected owner, Space, bot, thread,
model, named connection and profile revision before restoring anything.
It never chooses the most recent session or replays app messages into a resumed
turn. Each child still has fresh scratch. Only its one expected bounded
transcript can become a candidate, after a successful process exit and the
current assistant record are verified. Missing or invalid snapshots fail
rather than starting a different session.

The app does not yet bind these snapshots to owner DMs or store them durably.
A later slice must recheck current access, encrypt the snapshot, publish it
only with a successful fenced turn, and delete it on chat clear or expiry.
Do not share a whole config directory or enable operator-facing resume before
those safeguards and the staging gate are verified.

## Pause and rollback

Stop accepting new pilot turns first (disable the launcher configuration for
the API while retaining the enrolled IDs). Finish or cancel all marked runs,
including queued and recoverable attempts. Workers that no longer allow a
previously marked run fail it rather than falling back. Clear the bot
allowlist only when the owner is ready for new direct messages to use Pi
again. Downgrade only after no marked runs can execute. Leave the additive
columns in place; do not strip markers from pending rows.

An offline SDK contract test does not establish the deployed sandbox
boundary. Keep the feature off where that environment cannot be verified.
