# iOS screenshot catalog

Local, agent-run capture of the Rakazo iOS app. It is not part of CI.

One command signs into disposable fixture accounts, runs the Maestro flows in
`catalog.json`, and writes PNGs plus a static `index.html` gallery. Add a screen
by dropping a flow under `flows/` and appending one entry to `catalog.json`.

The app under test must already be installed on the simulator in `SIM_UDID`.
This command does not create or boot a simulator. Point the app at a running
API (`RAKAZO_API_URL`) and Metro bundler before you start. `DATABASE_URL` must
be that API's database so the fixture can insert thread messages.

```sh
SIM_UDID=00000000-0000-0000-0000-000000000000 \
RAKAZO_API_URL=http://127.0.0.1:3110 \
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/rakazo \
RAKAZO_SCREENSHOT_EMAIL=ios-screenshots@example.test \
RAKAZO_SCREENSHOT_EMPTY_EMAIL=ios-screenshots-empty@example.test \
RAKAZO_SCREENSHOT_PASSWORD='replace-with-a-disposable-password' \
pnpm ios:screenshots
```

Run one section:

```sh
pnpm ios:screenshots -- --section settings
```

Output defaults to `test-report/ios-screenshots` (gitignored). Override it with
`IOS_SCREENSHOT_OUT`. Open `index.html` in that folder. Maestro must be on `PATH`.
