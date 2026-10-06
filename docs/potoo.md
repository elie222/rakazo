# POTOO night flights

POTOO runs reporter patrols on a schedule. A patrol files copy as a
fenced json block (`findings`, `back_page`, `record`). Bloody patrols
escalate to a senior correspondent for re-verification. Malformed copy
gets one logged repair. Beats are versioned briefs in
`packages/potoo/beats/`, derived from pstack patterns (MIT).

## Temperatures

Patrol flights run at `0.2`, escalation at `0.3`. Both are pinned by
the executor when the run prompt carries a POTOO marker; ordinary runs
keep the provider default. No per-provider settings are involved.

## Seeding

```ts
import { seedPotooRoutines } from "@rakazo/adapters";

await seedPotooRoutines(
  { prisma, jobs },
  {
    spaceId, userId, botId, // the night-shift bot
    beats: [
      { name: "investigation", brief: "<contents of beats/investigation/SKILL.md>" },
      { name: "bug-fix", brief: "<contents of beats/bug-fix/SKILL.md>" },
    ],
    repo: "/home/potoo/repo",
    date: "2026-10-06",
    cron: "0 2 * * *",
    timezone: "UTC",
  },
);
```

Reseeding is safe: existing `POTOO <beat>` routines are skipped.
A failed wakeup enqueue deletes the routine row instead of leaving a
run that never fires.

## The loop

1. A routine fires; the run carries the beat brief plus the night
   assignment, with the newsroom frame and output contract prepended
   to system instructions.
2. On completion the executor checks the final text:
   - high-severity findings → enqueues `potoo.escalate` with the patrol
     run id. The handler reloads the report and the redacted tool
     transcript from the database and files one escalation run in the
     same thread. One escalation per patrol run.
   - missing or malformed json block → files one repair run with the
     same system and temperature plus the original reply. Repairs never
     repair again.
   - anything else → the night ends quietly.

## Flight records

Follow-up runs link to their origin by run `clientNonce`:

- `potoo:escalation:<patrolRunId>`
- `potoo:repair:<originalRunId>`

Query runs by `clientNonce` to audit any flight. Escalation and repair
runs use `trigger: "routine"`, so they stay isolated from thread
history and carry their full context in the prompt.

## Beats

One deviation from the paper assembly is deliberate: the beat brief
travels in the routine (user) prompt so runs are self-contained, while
P1 plus the output contract travel in system instructions. Add beats
as `beats/<name>/SKILL.md` with `name`/`description` frontmatter so
they parse with the existing skill tooling.
