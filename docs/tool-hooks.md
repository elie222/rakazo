# Tool hooks

Tool hooks let an operator put their own checks around the tool calls a bot makes, without
changing Rakazo. A hook is an HTTP endpoint you run. Rakazo calls it before a tool runs and
after it returns, and the hook answers **allow**, **warn** or **deny**.

Typical uses:

- an injection classifier on what a tool returned (`after`), so a poisoned web page is caught
  before the model reads it;
- a data-loss filter on what a tool is about to send (`before`), so a key or a private document
  does not leave in a URL, a command or an email body;
- an audit trail of every call to an external system.

Hooks are off unless you configure them, and cost nothing when off.

## Configure

Set one of these on both the API and the worker:

| Variable | Meaning |
| --- | --- |
| `RAKAZO_TOOL_HOOKS` | The config as inline JSON. |
| `RAKAZO_TOOL_HOOKS_FILE` | Path to a JSON file with the config. Prefer this when a hook needs a bearer token, so the token stays out of the process environment. |

Setting both is an error. A malformed config, a setting Rakazo does not know (a typo such as
`onerror`), or a missing `onError` stops the process at startup instead of leaving a check
silently on a default.

```json
{
  "hooks": [
    {
      "name": "egress-filter",
      "url": "http://hooks.internal:9000/before",
      "phases": ["before"],
      "timeoutMs": 2000,
      "onError": "deny",
      "bearerToken": "…"
    },
    {
      "name": "injection-scan",
      "url": "http://hooks.internal:9000/after",
      "phases": ["after"],
      "onError": "allow"
    }
  ]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `name` | required | Shown in logs and in the message the model sees when a call is blocked. Must be unique. |
| `url` | required | `http` or `https` endpoint that receives a `POST`. No credentials in the URL; redirects are refused. |
| `onError` | **required** | `allow` or `deny`: what to do if the hook is unreachable, slow, answers something that is not a decision, or the payload is too large to send. A hook that is a safety gate should say `deny`. |
| `phases` | `["before","after"]` | When to call the hook. |
| `tools` | all tools | Exact tool names, or a prefix ending in `*` (`browser_*`). See the limits below. |
| `timeoutMs` | `3000` | Whole number, 1 to 30000. Covers reading the answer. |
| `maxPayloadChars` | `200000` | Largest serialized arguments or result (1000 to 2000000) sent to the hook. A larger one is **not** sent in part: it counts as a hook error, so padding cannot push a secret past what the hook sees. |
| `bearerToken` | none | Sent as `Authorization: Bearer …`. Printable characters, no spaces. Use `https` unless the hook is on a private network. |

Hooks run in the order listed. The first `deny` ends the check.

## The request

```json
{
  "phase": "before",
  "tool": "web_fetch",
  "callId": "…",
  "args": { "url": "https://example.com/?q=1" },
  "result": "…only in the after phase…",
  "run": { "id": "…", "botId": "…", "trigger": "chat", "tainted": true }
}
```

`callId` pairs a `before` with its `after`, including for parallel calls. `run.tainted` is true
once outside content (a web page, an inbound message, a connector read) has entered the run, the
same signal the built-in approval rules use; for an `after` request about a tool that returns
outside content, it is already true. For `web_fetch`, `args.url` is the URL that will really be
fetched, after the same normalization the fetch gate applies.

## The answer

```json
{ "decision": "allow" }
{ "decision": "warn", "reason": "short text" }
{ "decision": "deny", "reason": "short text" }
```

The decision is read without regard to case, and a `deny` or `warn` is honored whatever the HTTP
status. An `allow` sent with an error status is not trusted: it counts as a hook error.

| Phase | `deny` | `warn` |
| --- | --- | --- |
| `before` | The tool does not run. The model is told `Blocked by tool hook <name>.` | The tool runs. The warning is logged. |
| `after` | The result is replaced, so the model never reads it. The model is told the tool already ran and not to repeat the call. | The result is returned with a note the model reads: appended to a string, added as a text part of a tool-result envelope, or set as `toolHookNotice` on an object. Arrays and plain values cannot carry a note; the warning is only logged. |

The hook's `reason` goes to the logs and nowhere else. A classifier that quotes the page it
caught would otherwise hand the injection back to the model.

## What is covered

- Every tool call a bot makes, built-in or connector, including the calls a subagent makes.
- A shell command that is still running when its call returns: its final output, delivered
  later, goes through the `after` hooks before the bot reads it.
- A routine's watch, which runs a connector tool on a schedule: it goes through the hooks with
  `trigger: "routine_watch"` and `tainted: true`.

A call that is paused for an approval is not sent to the `after` hooks, so the approval card
reaches the owner unchanged. Approvals still apply: a hook adds a check, it never grants one.

## Limits to know about

- **Catalog tools.** A connector with many tools is reached through a wrapper tool such as
  `<connector>_execute_tool`, with the real tool named inside `args`. A hook sees the wrapper's
  name, so a `tools` list naming the inner tool does not match. Leave `tools` empty for a gate,
  or match the wrapper.
- **Arguments are the model's.** Apart from `web_fetch` URLs, a hook sees the arguments the model
  supplied. A call resumed after an approval runs the arguments that were approved, which the
  `before` hook saw when the call first paused.
- **Side effects.** An `after` hook cannot undo a tool that already ran. Use `before` to stop an
  action; use `after` to keep a result from the model.
- **Parallel calls.** `run.tainted` is read when a call starts, so a call racing an outside read
  can still see `false`.
- **Latency.** Hooks are called one after another on every matching call, each up to its
  `timeoutMs`. There is no circuit breaker: a dead hook with `onError: "allow"` adds its timeout
  to every call. Keep hooks fast and close.
- **Names are not checked.** Rakazo cannot tell that a `tools` entry names no real tool.

## Safety notes

- A hook receives full tool arguments and results, which can contain private data and secrets.
  Point hooks only at services you run and trust, and prefer a private network.
- Hook configuration is operator-only. Bots and users cannot add or change hooks, but the model
  is told the name of a hook that blocked a call.
- Every `warn`, `deny` and hook failure is logged as `tool.hook.verdict` with the hook, tool,
  decision, run and bot, plus the hook's reason. Arguments and results are never logged, but a
  hook that puts a secret in its `reason` puts it in the log.
- If a hook is a safety gate, set `onError` to `deny` and a short `timeoutMs`; a hook that is down
  then stops the call, not the protection.
