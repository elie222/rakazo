# Tool activity

Bot replies in the web app and the Electron desktop app can show a small card listing the
tools the bot called during the run.

## Behavior

- Off by default, so chats stay clean. **Settings → General → Advanced → Show tool activity** turns it on. Nothing stored counts as off; only a saved "on" shows the cards.
- The choice is stored in the browser's local storage (`rakazo.showToolActivity`), so it
  applies to that browser or desktop install only. It is not saved to the account and does
  not sync between devices.
- While a run is live, the card starts open and lists the last six steps, with a count
  of the earlier steps. A step can represent repeated calls to the same tool.
- Collapsing a live card keeps it collapsed while that card stays mounted. If a tools-only
  message gains narration text, the card moves into a reply bubble and opens again.
- When the run finishes, the card folds to one line with the tool count and duration.
  Expanding it lists every step.
- A bot message that so far contains only tool calls renders as a slim line between
  messages, not as a chat bubble.
- With the setting off, tool calls are hidden and only the bot's written reply shows.

The setting only changes what the client renders. The thread events, stored messages, and
API responses are the same with it on or off.

## Platform scope

| Surface | Status |
| --- | --- |
| Web | Supported |
| Electron desktop | Supported (hosts the web UI, stores the choice in its own local storage) |
| Expo mobile | Not included. Mobile keeps hiding tool activity, which is the previous behavior, so nothing changes there. |

## Tests

- Unit tests: `apps/web/src/components/ToolActivityDisclosure.test.tsx`,
  `apps/web/src/lib/tool-activity-preference.test.ts`,
  `apps/web/src/lib/tool-activity-view.test.ts`, and
  `apps/web/src/pages/AccountSettingsOverlay.test.tsx`.
- UI E2E with fake data and screenshots: `apps/web/e2e/tool-activity.spec.ts` covers the
  `apps/web/e2e/fixtures/tool-activity.html` fixture and one scripted-runtime chat turn in
  the real app. `apps/web/e2e/tool-activity-disclosure.spec.ts` checks the setting-off view
  on desktop and mobile widths.
