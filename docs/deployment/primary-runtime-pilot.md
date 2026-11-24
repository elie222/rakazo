# Primary runtime pilot

Off by default. It changes only the selected bot owner's plain-text app direct
chat. A pilot turn uses the configured named API-key connection and model as of
enqueue; it never uses the deployment/default key or falls back to another
engine. Connections remain controlled by existing bot settings. Ordinary Pi
turns, team chat, routines and other entry points are unchanged. No provider
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
