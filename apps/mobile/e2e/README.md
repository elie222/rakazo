# Mobile emulator smoke test

This opt-in [Maestro](https://maestro.mobile.dev/) flow exercises sign-in, bot creation,
thread messaging, and computer takeover/release on a real Android emulator or iOS simulator. It
expects a running Rakazo stack and deliberately stays out of ordinary pull-request CI.

## Prerequisites

1. Install the Maestro CLI and start an Android emulator or iOS simulator.
2. Start Rakazo's database, API, worker, and sandbox supervisor. The computer portion requires a
   working sandbox provider (the normal local Docker provider is sufficient).
3. Create a disposable test account through the mobile or web sign-up screen. Never use a
   production account or put credentials in this repository.
4. Build/install the native app with an API URL that the emulator can reach. For the standard local
   ports, use `http://10.0.2.2:3100` on the Android emulator and `http://127.0.0.1:3100` on the iOS
   simulator. For example:

   ```sh
   EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 pnpm --filter @rakazo/mobile android
   ```

## Run

Pass all fixture values at invocation time so credentials never land in source control:

```sh
pnpm --filter @rakazo/mobile test:e2e -- \
  -e RAKAZO_E2E_EMAIL=mobile-smoke@example.test \
  -e RAKAZO_E2E_PASSWORD='replace-with-the-disposable-password' \
  -e RAKAZO_E2E_BOT_NAME=MaestroSmoke-001 \
  -e RAKAZO_E2E_MESSAGE=mobile-smoke-message
```

Use a new bot name for each run if the backing database is persistent. `clearState` resets the app's
local session and endpoint data; it does not delete server-side bots.

## Screenshot catalog

Run **Actions → mobile Android screenshots → Run workflow** to build the app, seed an isolated fake
workspace, capture light and dark Android emulator views, and upload the screenshots and Maestro report for
seven days. It uses no repository secrets or hosted providers.
