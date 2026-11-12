# Agent loop (self-host)

Optional flags keep upstream defaults until you turn them on. Set them on the API and worker (same `.env`).

| Variable | Default | When enabled |
| --- | --- | --- |
| `RAKAZO_OPEN_WORK_LOOP_ENABLED` | `false` | After a text reply, the bot starts another run while unblocked scratchpad items (`status: open`) remain. |
| `RAKAZO_OPEN_WORK_LOOP_MAX_REWAKES` | `12` | Max automatic continuations per mission. |
| `RAKAZO_OPEN_WORK_LOOP_MAX_WALL_CLOCK_MS` | `2700000` (45 min) | Wall-clock budget per mission. |
| `RAKAZO_OPEN_WORK_LOOP_STALL_THRESHOLD` | `3` | Stop when the same open-work fingerprint repeats this many times without progress. |
| `RAKAZO_NON_BLOCKING_ASKS_ENABLED` | `false` | `ask_user` and `request_secret` post cards but do not pause while other open work remains. |
| `RAKAZO_SILENT_TOOL_CONTINUATIONS_MAX` | `3` | Cap on automatic “continue after tool result” nudges inside one run. |
| `RAKAZO_SILENT_TOOL_CONTINUATION_MODE` | `ask` | `keep_going` tells the model to try another route and ask only for hard limits. |
| `RAKAZO_AGENT_CONTEXT_STRATEGY` | (deployment default) | Override context strategy, e.g. `current` for window + compaction. |
| `RAKAZO_AGENT_CONTEXT_COMPACTION_PIN_OPEN_WORK` | `false` | Append the live scratchpad list to each new compaction summary. |
| `RAKAZO_WAITING_ON_CHILD_INDICATOR` | `false` | Reserved for a follow-up UI pass; no effect in v0.11.0 patch. |

Turn everything on (Lokey-style):

```env
RAKAZO_OPEN_WORK_LOOP_ENABLED=true
RAKAZO_NON_BLOCKING_ASKS_ENABLED=true
RAKAZO_SILENT_TOOL_CONTINUATIONS_MAX=8
RAKAZO_SILENT_TOOL_CONTINUATION_MODE=keep_going
RAKAZO_AGENT_CONTEXT_STRATEGY=current
RAKAZO_AGENT_CONTEXT_COMPACTION_PIN_OPEN_WORK=true
```

User **Stop** on a thread cancels queued open-work continuations like any other run. Child jobs and cloud agents still wake the parent through existing completion paths.
