# Response streaming visuals

These images are Playwright captures of `apps/web/e2e/fixtures/response-streaming.html`.

They are **not** a live model session. The default scripted e2e runtime does not flush assistant token progress, so this page feeds the same `thread.progress` / `thread.message.created` events through `reduceThreadSnapshot` and `withLiveStreamingProgress`, then renders them with the product `ChatMarkdown` bubbles, working glyph, and Settings overlay. Mobile has the same **Stream replies** switch; these frames are the web overlay and reducer path.

## What each file shows

- `settings-stream-on.png` — Settings → General, **Stream replies** on (default).
- `settings-stream-off.png` — same control off.
- `settings-stream-replies-on.png` / `settings-stream-replies-off.png` — the **Replies** row only.
- `settings-stream-on-narrow.png` — the same on control at a 390×844 viewport.
- `thread-stream-on-live.png` — streaming on, mid-turn partial assistant text plus the streaming caret.
- `thread-stream-off-live.png` — streaming off, same mid-turn events: no token drip; working indicator only.
- `thread-stream-off-done.png` — streaming off after `thread.message.created`: the finished assistant message.

## Reproduce

From the repo root, with Playwright Chromium installed:

```bash
UPDATE_RESPONSE_STREAMING_DOCS=1 pnpm --filter @rakazo/web exec playwright test e2e/response-streaming.spec.ts
```

That writes these PNGs and attaches the same frames to the Playwright report. Omit the env var to run the assertions without rewriting the files.
