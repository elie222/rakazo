# Tool activity

Bot replies in the web, desktop and mobile apps can show a small card listing the tools the
bot called during the run.

## Behavior

- Off by default, so chats stay clean. **Settings → General → Advanced → Show tool activity** turns it on. Nothing stored counts as off; only a saved "on" shows the cards.
- The choice is stored in the browser's local storage (`rakazo.showToolActivity`), so it
  applies to that browser or desktop install only. It is not saved to the account and does
  not sync between devices.
- While a run is live, the card starts open, counts up the time since the run's first
  activity, and lists the last six steps, with a count of the earlier steps. A step can
  group repeated shell calls with the same command.
- Each step shows the tool, its duration, and whether it succeeded, failed, or is still
  running. Shell steps also show a shortened, redacted command line.
- A step opens to the chat's own code block: a shell command and its output as one console
  block (following live while it runs), otherwise the call's arguments as JSON and what it
  returned (JSON indented, secrets taken out), with the block's copy control, and the exit
  code or error under it.
- A call shows as a step as soon as it starts. Only a call that lands mid-sentence in the bot's
  own text waits for that sentence to end; a tool status line never holds one back.
  A running shell command's output follows live. Rows of a finished run read their results
  on demand from the run's events; a step saved before results were recorded shows
  "No output recorded".
- Collapsing a live card keeps it collapsed while that card stays mounted. If a tools-only
  message gains narration text, the card moves into a reply bubble and opens again.
- When the run finishes, the card folds to one line with the tool count and duration.
  Expanding it lists every step.
- A bot message that so far contains only tool calls renders as a slim line between
  messages, not as a chat bubble.
- With the setting off, tool calls are hidden and only the bot's written reply shows.

The setting only changes what the client renders. The thread events, stored messages, and
API responses are the same with it on or off.

## Data

- A `steps` block row carries the call's `executionId`, `detail`, `outcome` and
  `durationMs`, all optional, so replies saved before this stay readable.
- The `agent.tool.called` event carries redacted shell command details or a structured
  tool's bounded, redacted arguments (`input`). The `agent.tool.completed` audit can carry
  a bounded, redacted result preview. Browser and computer actions omit arguments and
  previews because typed values may contain credentials. Strings are redacted before serialization,
  so a secret that JSON would escape cannot slip through, and a string under a
  credential-named key (password, token, API key, authorization, cookie and similar) is
  dropped whole. Shell commands keep streaming their output through `computer.command`
  events as before.
- `input`, `preview` and a call's error text reach only the person who started the run, in
  the live stream and in `threads.toolCalls`. Anyone else who can read the chat sees the
  steps, their outcomes and shell output, which the live feed already showed every reader;
  their records carry `withheld`, so the panel does not claim the call printed nothing.
- A call that finishes before its own event is written carries its `outcome` and `durationMs`
  on `agent.tool.called`, so its step never stays marked running.
- `threads.toolCalls` reads a run's first 2,000 calls with their completions, through the
  database client so encrypted payloads are opened, and folds them into one record per call.
  A shell call's event carries its whole redacted command, and its completion the exit code
  (null while it still runs past its call) and the end of what it printed, so a stored run
  can read its own completion. When a command finishes after the tool call returns, the
  API reads the terminal command event for the final output and exit code. It skips running
  output frames. Clients clear live records when the run ends or the account changes.
  Thread snapshots omit `input` and `preview`; opened rows fetch them on demand.

## Platform scope

| Surface | Status |
| --- | --- |
| Web | Supported |
| Electron desktop | Supported (hosts the web UI, stores the choice in its own local storage) |
| Expo mobile | Supported, behind the same switch under **Settings → Advanced → Show tool activity**, stored on the device. Rows open to the same terminal panel; Copy uses the system clipboard. |

## Tests

- Unit tests: `apps/web/src/components/ToolActivityDisclosure.test.tsx`,
  `apps/web/src/lib/tool-activity-preference.test.ts`,
  `apps/web/src/lib/tool-activity-view.test.ts`,
  `apps/web/src/lib/tool-call-records.test.ts`,
  `packages/core/src/tool-call-records.test.ts`,
  `apps/mobile/lib/tool-activity-card.test.tsx`,
  `apps/mobile/lib/message-presentation.test.ts`, and
  `apps/web/src/pages/AccountSettingsOverlay.test.tsx`.
- iOS screenshot catalog: the `tool-activity` section turns the switch on, runs a scripted
  shell call, and opens its row.
- UI E2E with fake data and screenshots: `apps/web/e2e/tool-activity.spec.ts` covers the
  `apps/web/e2e/fixtures/tool-activity.html` fixture and one scripted-runtime chat turn in
  the real app. `apps/web/e2e/tool-activity-disclosure.spec.ts` checks the setting-off view
  on desktop and mobile widths.
