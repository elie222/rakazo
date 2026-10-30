# Audit log

Rakazo keeps a record of who did what in each organization: which bot or person took an action,
what was approved and by whom, and which settings and credentials changed. Recording is always on.

Organization owners and admins can export it as JSON Lines, and operators can forward it to a SIEM.

## What is recorded

| Action | When |
| --- | --- |
| `tool.call` | A bot ran a consequential tool, or was refused one by a rule (`outcome` is `success`, `failure` or `denied`) |
| `approval.decided` | A person allowed or denied an action a bot asked for |
| `approval.auto_reviewed` | The auto-reviewer judged an action (`metadata.decision`) |
| `approval.policy.changed` | Approval mode, allow/block rules, or a space setting changed |
| `credential.created`, `credential.changed`, `credential.deleted`, `credential.revealed` | Model, MCP, connector, voice, memory, vault and bot secrets |
| `space.created`, `space.renamed`, `space.deleted` | Spaces |
| `auth.sign_in`, `auth.sign_out`, `auth.password.changed`, `auth.passkey.*`, `auth.session.revoked`, `device.*` | Account security, recorded in each organization the account belongs to |
| `audit_log.exported` | Someone exported the audit log |

Each event has the time, actor (user, bot or system, with a display label), action, target,
outcome, space, run and chat ids, the client address and user agent for people, and a few
identifiers. Labels are copied when the event is written, so the record still reads correctly after
the space, chat, run, bot or account is deleted. Events never include message content, tool
arguments, or secret values.

Actor labels (a person's email), client addresses and user agents stay in the log after the account
is deleted, until retention prunes them, and in any SIEM they were forwarded to.

Rows are never updated. Postgres rejects updates, and the only delete is retention pruning.
Failed sign-ins, rate limits and refused destinations have no organization to belong to; they stay
in the deployment's [security events](./self-host-observability.md#security-events).

## Retention

`AUDIT_EVENT_RETENTION_DAYS` (default 365) sets how long events are kept. Pruning runs about once an
hour on the elected reconciler, so one instance prunes however many run.

## Forwarding to a SIEM

Set `AUDIT_LOG_WEBHOOK_URL` to an HTTPS endpoint and the reconciler posts every event to it, oldest
first, as `application/x-ndjson` (one JSON event per line, the same shape as the export).
`AUDIT_LOG_WEBHOOK_AUTHORIZATION`, when set, is sent as the `Authorization` header, for example
`Bearer <token>` or `Splunk <token>`.

Delivery is at least once: deduplicate on `id`. Events are sent about a minute after they are
written. When the endpoint fails, Rakazo keeps its place and retries with backoff up to an hour
apart, so nothing is skipped while it is down. Events pruned by retention before they are delivered
are not sent.

## Export and API

`GET /api/audit-events/export` returns the organization's events as JSON Lines, newest first, for
a signed-in owner or admin. It accepts `from` and `to` (ISO 8601), `spaceId`, `actorId` and
`action` filters. The `audit.events` RPC returns the same events in pages with a `nextCursor`.
