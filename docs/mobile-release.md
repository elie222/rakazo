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

## Release

Bump `expo.version` in `apps/mobile/app.json` when native code changes (see
Over-the-air updates below), then run the `release-mobile` workflow from `main`
with the App Store "What's New" text. It builds iOS on EAS, uploads it to App
Store Connect, puts the build on that App Store version with the notes, and
submits it for review; Apple releases it once approved. The same run submits a
production Android App Bundle to Google Play for review and publishes the
Android APK below. The stores review independently, so publication times differ.

It needs these repository secrets:

- `EXPO_TOKEN`: an Expo access token for the project.
- `ASC_APP_ID`: the app's Apple ID, shown under App Information in App Store
  Connect.
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`: an App Store Connect API
  key with the App Manager role, from Users and Access > Integrations. The
  private key is the contents of the downloaded `.p8` file.

Re-running it for a version that is already in review leaves that submission
alone.

If the iOS upload succeeded but App Review submission failed, run `release-mobile`
with `ios_build_id` set to that finished EAS build's ID and the release notes.
This retries only App Review: it skips both Android jobs, the iOS build, and the
upload. The workflow verifies that the reused build belongs to this app and was
built with the production iOS profile. Review failures include Apple's associated
validation errors so missing metadata can be corrected before retrying.

## Google Play

Run `release-google-play` from `main` for an Android-only store release, or
`release-mobile` for both stores. The production EAS profile increments the
Android version code automatically and retains the production update channel
and managed upload key. The workflow checks native dependency compatibility,
builds an AAB, and requires its R8 report to show at least 25% optimization,
obfuscation, and shrinking, with a crash deobfuscation mapping included.

Configure a Google service account with access to publish this app in Play
Console, then assign its key under Android submissions in `eas credentials`.
EAS stores the key; do not commit it or add it to `eas.json`. The workflow uses
the existing `EXPO_TOKEN` secret to build and submit non-interactively. The
`GOOGLE_SERVICES_JSON` production file variable is also required for push.

The submit profile targets production with a completed rollout and sends the
changes for review. Submission success means Google accepted the upload, not
that it approved or published the app. Check Publishing overview and Production
in Play Console after submission, and inspect the new bundle's optimization
scores once processed. Managed publishing can delay release after approval.

## Android APK

Android users should install [Rakazo from Google Play](https://play.google.com/store/apps/details?id=com.rakazo.app).
For manual installation, an APK remains available.
`release-mobile` publishes it, or run the `release-android-apk` workflow from
`main` on its own. It builds the `android-apk` EAS profile, signed with the
project's managed keystore, and replaces the rolling `android` GitHub release,
so the download link stays the same:

```text
https://github.com/elie222/rakazo/releases/download/android/rakazo.apk
```

The APK uses the production update channel, so JavaScript changes reach it
through the over-the-air updates below without a new APK. A Google Play install
is signed with Play's key, so switching from the APK to Play means uninstalling
the APK first.

## Android push

For Android push notifications, create a Firebase project and register the app's
Android package. Download `google-services.json` and, from `apps/mobile`, store
it as an EAS file environment variable:

```sh
eas env:set production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret
```

Keep the file and credentials out of Git. Upload an FCM V1 service account key
with `eas credentials` under Android > Google Service Account > FCM V1. Then
rebuild the APK: Firebase configuration is native, so an OTA update cannot add
it to an existing binary. Builds without the variable remain supported.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. The runtime version follows the public app version, so bump
`expo.version` whenever native code, config plugins, permissions, or native
dependencies change, then create and submit new store builds.

After the full GitHub Actions test suite passes on `main`, CI publishes a
production OTA update when the revision only changes the mobile JavaScript,
TypeScript, or bundled CSS. CI deliberately skips OTA publishing when native
configuration, modules, dependencies, assets, or the update workflow changed.
The repository needs an `EXPO_TOKEN` Actions secret with access to the linked
Expo project.

To publish a compatible update manually from `apps/mobile`:

```sh
eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
