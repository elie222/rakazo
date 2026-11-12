# Service API

The service API lets a program, such as a script or another agent, work with your bots without signing in as you. It covers bots, conversations, computers, memory, routines, files, scratchpads, skills, pages, group chats, tickets, usage, search and the audit log.

Create a key in **Settings > API keys**. You confirm your identity first, and the key is shown once. Rakazo keeps only its hash. No key exists until you make one.

The full, always-current list of operations is `GET /api/service/v1/openapi.json`, an OpenAPI 3.1 document generated from the table the server enforces.

## What a key can do

A key acts as you, in the space it was created in, and never reaches more than you can. Every call runs the same permission checks as the app.

| Scope                                     | Allows                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| `bots:read`, `bots:write`                 | List, read, create, change, archive and restore bots          |
| `conversations:read`                      | Read conversations and runs, and follow live events           |
| `prompts:write`                           | Send a bot or group a message, and stop its work              |
| `computer:read`, `computer:write`         | Read, start and stop a bot's computer                         |
| `memory:read`, `memory:write`             | Read and replace a bot's memory documents                     |
| `routines:read`, `routines:write`         | List, create, change and run routines, and read their history |
| `artifacts:read`                          | List and download a bot's files                               |
| `scratchpad:read`, `scratchpad:write`     | Manage a bot's scratchpad                                     |
| `skills:read`, `pages:read`               | List a bot's taught skills and saved pages                    |
| `groups:read`, `groups:write`             | Manage group chats                                            |
| `tickets:read`, `tickets:write`           | Read boards, and read, create, change and comment on tickets  |
| `usage:read`, `search:read`, `audit:read` | Read usage totals, search, and read the audit log if you may  |

A key may be limited to chosen bots. A key with no list reaches every bot you can reach, including ones you add later. A limited key cannot make a call that spans the whole space, such as search, usage, group chats or listing ticket boards. It sees only tickets assigned to its bots, and no runs in group chats. A bot's status includes its computer's state only for a key with `computer:read`.

A key always expires, after 365 days at most. To rotate one, create its replacement, move your program over, then revoke the old one. Revoking takes effect on the next request, and within seconds on an open event stream. Leaving a space, or being removed from it, revokes your keys there, and being invited back does not restore them.

## What no key can do

These stay with a person in the app:

- Answer an approval, a question or a request for a login. A bot holding a key must not be able to approve its own work, so an `ask` block reports only its text and status.
- Read or change secrets, the vault, connections or MCP servers.
- Create or revoke keys, so a leaked key cannot mint another.
- Change billing, deployment, members or the space itself.
- Delete bots, routines, memory or conversation history. Archive a bot or deactivate a routine instead.
- Change settings that widen what a bot may reach: `crossSpaceCommunication`, `fleetManagement`, `disabledBuiltinTools` and `memoryScope`, or a routine's webhook, GitHub, email, messaging or watch triggers.

## Messages sent with a key

A message sent with a key is marked by the platform with the key's name. The sender cannot set or remove the mark. You see it in the chat, API readers see a `sent_with_key` block, and the bot reads it as part of the message.

A run started this way is not treated as one you started. The bot does not get its bot management tools or the tools for connecting to other people's agents, and the text does not count as your words when Auto Review or site trust decides what is allowed. Your approval settings still apply, and any approval card comes to you. A message sent with a key while the bot is working waits for its own run instead of steering the current one.

A routine prompt written with a key stays marked as the key's until you save the routine in the app. Until then its runs, scheduled or not, have the same limits as a run started with a key: no tools for connecting to other people's agents, and Auto Review and site trust do not treat the prompt as your words.

Instructions and memory written with a key are saved as yours, and later runs treat them that way, so `bots:write` and `memory:write` are the scopes to grant with care.

A key's message never answers a question a bot is waiting on. The bot keeps waiting for you, and the message gets its own run afterwards.

A message sent while the bot is busy waits for a run of its own. The response has `held: true` and `runId: null`. With `?wait=`, the request follows the message into that run and returns its reply, within the time you allowed. Without it, send the same request with the same `Idempotency-Key` to get the run once it exists; nothing is sent twice. Several waiting messages can share one run. Stopping the bot drops waiting messages, as it does in the chat, and the response then has `held: false` and `runId: null`.

Stopping a run leaves its request in the conversation, as it does in the chat, so the bot can pick that work up again on its next message. Say so in that message if it should not.

The web and mobile apps both show the mark. Creating and revoking keys is only in the web app for now.

## Requests

Send the key as `Authorization: Bearer <key>`. Every response carries `X-Request-Id`, and every authenticated one carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Each key may make 120 requests a minute.

Every change is recorded in the organization's audit log with the key as its actor, on behalf of you. Reads are not, but a key's last use is shown in settings.

Conversations return only what a person sees: text, questions and their status, files, pages, and messages from other bots or chat apps. Tool calls, their results and everything else in a message stay in the app. Responses are built from an allowlist, so a new internal field does not appear here on its own.

### Retrying writes

A call that creates something needs an `Idempotency-Key` header of up to 128 letters, digits or `._:-`. Retrying with the same key and the same request returns the first answer with `Idempotent-Replayed: true`, and starts nothing. Keys are private to each API key and last 24 hours. Using one for a different request returns `409 idempotency_conflict`.

If a write is refused the key is freed. A write still running keeps its key. If the outcome is unknown, such as a crash mid-write, the key is held for five minutes (`409 idempotency_in_progress`) and a retry after that runs the write again. Prompts and routine runs are stricter: the message or run itself carries the key, so they can never run twice.

Other calls refuse the header, so a program cannot believe a retry is safe when it is not.

```bash
curl -X POST "$RAKAZO_URL/api/service/v1/bots/$BOT_ID/prompts" \
  -H "Authorization: Bearer $RAKAZO_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: nightly-2026-01-01" \
  -d '{"text":"Summarize yesterday."}'
```

### Concurrent edits

`PATCH /bots/{id}` accepts `expectedInstructions`, and `PUT /bots/{id}/memory/{doc}` accepts `expectedRevision`. Either answers `409 conflict` if the value has moved.

### Waiting for a reply

`POST /bots/{id}/prompts?wait=60` holds the call for up to 60 seconds and adds `run` to the response: the run's status and what the bot said in it. `GET /runs/{id}?wait=60` does the same for a run you already started. `settled` is true once the run ended or the bot is waiting on a question for you. When it is false, the wait ran out, so call again.

### Live events

`GET /bots/{id}/events` is a server-sent event stream of new messages and run changes, filtered the same way as conversations. Each event's `id` is its sequence number. To resume, send it back as `Last-Event-ID` or `?cursor=`. With neither, the stream starts now. The first thing sent is the comment line `: connected`, so a client knows the stream is open before anything happens.

A stream closes after 15 minutes, so reconnect with the last id. A key may hold 5 streams at once, across every server.

## For agents

`POST /api/service/v1/mcp` serves the same routes as Model Context Protocol tools over streamable HTTP, with the key as the bearer token. Each tool is one route: path and query parameters are top-level arguments, the JSON body is `body`, and `idempotencyKey` is optional (one is made up when you leave it out, so pass your own to make a retry safe). A key is offered only the tools its permissions and bot list allow.

A tool call is carried out as the HTTP request it stands for, so limits, permissions and the audit log are the same either way. Live events are not offered as a tool.

## Errors

Errors look like `{"error": {"code": "...", "message": "..."}}`. A body that fails validation adds `fields`, a list of `path` and `message`.

| Status | Code                       | Meaning                                                         |
| ------ | -------------------------- | --------------------------------------------------------------- |
| 400    | `invalid_request`          | Bad body, header or query                                       |
| 400    | `idempotency_key_required` | This call needs an `Idempotency-Key`                            |
| 401    | `unauthenticated`          | Missing, unknown, revoked or expired key, or you left the space |
| 403    | `forbidden`                | The key lacks that scope                                        |
| 403    | `bot_limited_key`          | A key limited to certain bots cannot make this call             |
| 403    | `not_permitted`            | The key's creator cannot do that, whatever the key's scopes     |
| 404    | `not_found`                | No such resource, or one this key cannot reach                  |
| 405    | `method_not_allowed`       | See the `Allow` header                                          |
| 409    | `idempotency_conflict`     | Idempotency key already used for another request                |
| 409    | `idempotency_in_progress`  | The first request has not finished. See `Retry-After`           |
| 409    | `conflict`                 | The resource changed, or the space is being deleted             |
| 413    | `payload_too_large`        | Body over the limit for this call                               |
| 415    | `unsupported_media_type`   | Expected `application/json`                                     |
| 429    | `rate_limited`             | See the `Retry-After` header                                    |
| 429    | `too_many_streams`         | Close an event stream first                                     |
| 503    | `service_unavailable`      | Retry; for a write, use the same idempotency key                |
