# Mobile builds and store releases

Rakazo's public repository does not contain production App Store Connect,
Google Play, Apple team, or private EAS submission identifiers. Those values
belong in the release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the Rakazo
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

## Configure a build

1. Link `apps/mobile` to an Expo project owned by your account.
2. Choose unique iOS and Android application identifiers.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS build environment. Production
   builds require a valid HTTPS URL.
4. Keep store application IDs, team IDs, signing credentials, API keys, and
   review-account credentials out of Git.
5. Before a native iOS or Android build, run
   `pnpm --filter @rakazo/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
eas project:init
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.
