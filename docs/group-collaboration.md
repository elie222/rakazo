# Optional group collaboration (experimental)

The completion-driven group orchestrator lets a group task's first replying Bot coordinate evidence from other active group members. It is **off by default**. Names of groups are prompt context only, never feature switches or permission grants.

## Enable on a self-hosted deployment

Set these on the **worker** process after applying the additive database migration:

```env
RAKAZO_GROUP_REVIEW_ENABLED=true
RAKAZO_GROUP_REVIEW_SINCE=<UTC_ROLLOUT_TIMESTAMP>
RAKAZO_GROUP_HANDOFF_CONTEXT=true
```

`RAKAZO_GROUP_REVIEW_SINCE` must be the current rollout time in UTC, not a historical timestamp: previously completed runs should not be replayed. Rolling back requires disabling the feature flag first; the nullable state marker can remain in the database.

## How it behaves

- The Bot that receives the user's group request remains the coordinator. When it explicitly delegates via `handoff_to_bot`, that choice wins.
- Otherwise, after its first run completes, tasks go to the other active group members. If the original request contains `@BotName` mentions, only the mentioned peers are scheduled. There is **no additional dispatcher headcount limit** beyond the group roster. The existing job queue bounds execution concurrency, not total assignments.
- Each peer sees the current task and is prompted to provide distinct findings rather than immediately re-delegating. The coordinator then synthesizes their responses and may request targeted follow-up review for material gaps.
- A later user message supersedes the prior automatic workflow. The dispatcher uses stable nonces and a completion marker to avoid double scheduling. Stage and time bounds prevent unlimited retries.

**Limitations:** The initial coordinator may emit a preliminary reply before the synthesis; a later reply contains the combined report. Unmentioned group members all receive work by default, which can significantly increase model usage. The additional goal review is bounded and is not an unconstrained multi-agent planner. Tool access and authorization checks remain unchanged.

## Verification

The tests in `packages/adapters/src/local-group-{dispatch,review,history}.test.ts` cover member selection, a full ten-Bot group, duplicate prevention, cancellation/supersession, and follow-up synthesis. An isolated PostgreSQL 16 database successfully applied all 155 migrations, including the new group-review column and index. `local-group-dispatch.postgres.test.ts` verifies two independent database clients racing to fan out the same request, a member joining during peer work, and exactly one final synthesis; the existing PostgreSQL job-leadership and two-worker recovery tests also passed. Real different-model-provider end-to-end operation and mobile-device testing remain unverified, so treat the feature as experimental.
