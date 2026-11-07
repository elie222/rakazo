# iOS screenshot catalog

Screenshots of every iOS screen in its main states, on demand. It is not part of CI.

One command starts an isolated API, seeds disposable fixture accounts, runs the
Maestro flows in `catalog.json`, and writes PNGs plus a static `index.html` gallery.

## Run

You need Maestro on `PATH`, a running Postgres server, and a booted simulator
with a debug build of the app installed (`pnpm --filter @rakazo/mobile ios`
builds and installs one).

```sh
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/postgres pnpm ios:screenshots
```

- `DATABASE_URL` only names the server: each run drops and recreates its own
  `rakazo_ios_screenshots` database there, so no other database is touched.
- The API runs on port 3110 with scripted models, a fake computer, and offline billing,
  wallet, board, plugin marketplace, and app catalog. Nothing calls a hosted provider.
- Metro starts on port 8081, where debug builds load from, and stops after the run, so the
  screenshots always show the code on disk. Stop any other Metro first.
- With one simulator booted it is used automatically; otherwise set `SIM_UDID`.
- Output goes to `test-report/ios-screenshots` (gitignored); override it with
  `IOS_SCREENSHOT_OUT`. Open `index.html` there.

Run some sections only:

```sh
pnpm ios:screenshots -- --section settings --section billing
```

Add `--publish` to a full run to upload the gallery page and its screenshots to the
screenshot bucket and print its address. It reads the same settings as CI's publisher
(`S3_BUCKET`, an HTTPS `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`PLAYWRIGHT_PUBLIC_BASE_URL`) and checks them before capturing. Logs are never uploaded.

A failed section prints the Maestro step that failed and the path of the last
screenshot it took.

## Add a screen

Write a flow under `flows/`, or add steps to an existing one, and list the route
in that section's `screens` in `catalog.json`. A unit test fails when an app
route is neither captured nor listed as uncovered in
`packages/testkit/src/ios-screenshot-catalog.test.ts`, so new screens get added
here too.

Put `waitForAnimationToEnd` before each `takeScreenshot`, so captures never
show a screen mid-transition.

For iPhone Duo layouts, boot the iPhone Duo simulator, opened, and set `SIM_UDID`.
