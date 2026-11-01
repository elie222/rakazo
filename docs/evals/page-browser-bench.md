# Page-browser benchmark

`pnpm bench:page-browser` measures the computer's page-browser driver (`rakazo-page-browser`, behind
`browser_navigate`, `browser_snapshot` and `browser_act`) on a fixed suite of scripted tasks, so two
drivers can be compared on equal terms. It is a manual tool: it needs Docker and never runs in unit
tests or PR CI.

It starts a fresh `rakazo/computer:local` container (`pnpm sandbox:build`), serves the fixture pages
in `packages/testkit/src/page-browser-bench/fixtures` inside it over HTTPS on two sites (`localhost`
and `127.0.0.1`, so the partner frame is cross-site), and restarts its Chromium with a throwaway
profile that accepts their self-signed certificate. The driver is called exactly as the supervisor
calls it. Use `--exec="<command prefix>"` to run in an existing computer instead; the prefix must run
a command inside it with stdin attached, such as `docker exec -i <container>`.

```sh
# The driver in the image against the one before the agent-browser switch, three runs each.
pnpm bench:page-browser --driver=585fac380^ --driver=installed --repeat=3
# Side by side from saved results.
pnpm bench:page-browser --compare old.json new.json
```

`--driver` takes `installed` or any git ref; a ref's driver (and its `page_secrets.py`, when it has
one) is copied into the computer, so an alternative driver is measured by committing it on a branch.

Each task succeeds only by an observable effect: the fields the fixture server received, or the
page's URL. For every driver call the results file records latency, errors and fallbacks, and the
characters of the result as the model reads it (after `browserResultForModel` and the runtime's
12,000-character clip). Tokens are estimated at four characters each. `--live-sites` adds a few public
pages, measured for size and latency only.

The suite covers a link, a text form, a native select, a checkbox, same-site and cross-site frames,
a form far below the fold, a page much larger than the snapshot budget with its form last, a page
that replaces its form after load (stale refs), a page whose HTML and data each arrive late, a saved
login fill, and a card fill by card field. The long page is expected to fail while the snapshot keeps
the first controls: it shows what the budget hides.

An agent-level mode, where a model drives the real tools through the shared model connection and
completion, steps, tokens and cost are recorded, is not built yet.
