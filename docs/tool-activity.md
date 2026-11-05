# Tool activity

Bot replies in the web app and the Electron desktop app can show a small card listing the
tools the bot called during the run.

## Behavior

- Off by default, so chats stay clean. **Settings → General → Advanced → Show tool activity** turns it on. Nothing stored counts as off; only a saved "on" shows the cards.
- The choice is stored in the browser's local storage (`rakazo.showToolActivity`), so it
  applies to that browser or desktop install only. It is not saved to the account and does
  not sync between devices.
- While a run is live, the card starts open, counts up the time since the run's first
  activity, and lists the last six steps, with a count of the earlier steps. A step can
  represent repeated calls to the same tool with the same arguments.
- Each step shows the tool, the call's main argument (the shell command, path, query or
  similar, bounded and with secrets taken out), how long it took, and whether it succeeded,
  failed, or is still running.
- A step opens to a small terminal: the full shell command when there is one, what the call
  returned or printed (with secrets taken out), its exit code or error, and a Copy button.
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
- The `agent.tool.called` event carries the call's `detail`; the `agent.tool.completed` audit
  carries a bounded, redacted `preview` of the text the tool returned. Shell commands keep
  streaming their output through `computer.command` events as before.
- `threads.toolCalls` folds a run's completion and command events into one record per call
  for the expanded rows. Live runs apply the same events as they arrive.

## Platform scope

| Surface | Status |
| --- | --- |
| Web | Supported |
| Electron desktop | Supported (hosts the web UI, stores the choice in its own local storage) |
| Expo mobile | Not included. Mobile keeps hiding tool activity, which is the previous behavior, so nothing changes there. Copied message text lists each step with its detail. |

## Tests

- Unit tests: `apps/web/src/components/ToolActivityDisclosure.test.tsx`,
  `apps/web/src/lib/tool-activity-preference.test.ts`,
  `apps/web/src/lib/tool-activity-view.test.ts`,
  `apps/web/src/lib/tool-call-records.test.ts`,
  `packages/core/src/tool-call-records.test.ts`, and
  `apps/web/src/pages/AccountSettingsOverlay.test.tsx`.
- UI E2E with fake data and screenshots: `apps/web/e2e/tool-activity.spec.ts` covers the
  `apps/web/e2e/fixtures/tool-activity.html` fixture and one scripted-runtime chat turn in
  the real app. `apps/web/e2e/tool-activity-disclosure.spec.ts` checks the setting-off view
  on desktop and mobile widths.
