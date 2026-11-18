# Audit log

Rakazo keeps a record of who did what in each organization: which bot or person took an action,
what was approved and by whom, and which settings and credentials changed. Recording is always on.

Organization owners and admins can export it as JSON Lines, and operators can forward it to a SIEM.

## What is recorded

| Action                                                                                                         | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.call`                                                                                                    | A bot ran a consequential tool, or was refused one by a rule (`outcome` is `success`, `failure` or `denied`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `approval.decided`                                                                                             | A person allowed or denied an action a bot asked for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `approval.auto_reviewed`                                                                                       | The auto-reviewer judged an action (`metadata.decision`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `approval.policy.changed`                                                                                      | Approval mode, allow/block rules, or a space setting changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `credential.created`, `credential.changed`, `credential.deleted`, `credential.revealed`                        | Model, MCP, connector, voice, memory, vault and bot secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `credential.used`                                                                                              | The vault gave a bot a saved login, card, API key or command variable: to type into a page, to send to its site, or as a variable of a shell command that a run or a routine's change check runs. Logged once the page may have typed it, the request carrying it may have gone out, or the computer was sent the command with it, even with no answer back or if the step then fails; a fill, request or command refused before that isn't a use. Once per item and site each time a run starts or resumes, and once per variable for each check of a routine; a command variable has no site. A value a run reads only to hide it from its output isn't a use, and contacts, which bots read as ordinary text, aren't recorded. Where it lands and what it holds are below the table |
| `space.created`, `space.renamed`, `space.deleted`                                                              | Spaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `auth.sign_in`, `auth.sign_out`, `auth.password.changed`, `auth.passkey.*`, `auth.session.revoked`, `device.*` | Account security, recorded in each organization the account belongs to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `auth.account.deactivated`, `auth.account.reactivated`                                                         | The identity provider ([directory provisioning](./self-host-accounts.md#directory-provisioning-scim)) or the operator turned an account off or back on; the actor is the system, labelled `directory` or `operator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `audit_log.exported`                                                                                           | Someone exported the audit log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

An event about an item in a space's own vault, whatever it is, is recorded only in the space's
organization: in full when the person whose vault it is is a full member of that organization, and
otherwise, for a guest of a [shared space](./spaces.md#share-a-space) or someone who has left it,
in a withheld form. The withheld form keeps its time, action, outcome, actor, space, the item's id,
the run and chat ids, a person's client address and user agent, and of its details only the
procedure, kind, scope and tool; it never holds the item's name, username or site. No other
organization gets a record of it. An item in a person's account vault is their own: their own save,
import, reveal or removal of it is recorded only in their own organization, or in the withheld form
in the space's when they own none. A bot using it in their run in a space is recorded in the
space's organization, in full for a full member and withheld for a guest, who also gets the full
record in the oldest organization they own, with the space's id but not its name. A vault event
that doesn't say which vault it was is treated as one about a space's own vault.

A `credential.used` event has the bot as its actor, the item as its target (its id, and its name
unless the record is withheld) and the space. A run's use has the run and chat ids; a routine's
change check has neither. Its details are the `tool` (`browser_act`, `secret_request`, `shell`, or
`routine_watch` for a routine's change check), the item's `kind`, the vault it is in (`scope`),
and, unless the record is withheld, the item's `name` and the `site` a fill or a request went to.
It never holds a value.

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
