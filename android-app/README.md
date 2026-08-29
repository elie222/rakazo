# Rakazo for Android

Native Android client for Rakazo. This project intentionally has its own Gradle build and CI lane; it is not part of the repository's pnpm or Turbo workspaces.

## Requirements

- JDK 17
- Android SDK 37

## Build

```sh
./gradlew assembleDebug
```

The app connects to a self-hosted Rakazo server, stores its Better Auth session with an Android Keystore key, and renders the authenticated agents, activity, search, settings, and thread surfaces. Endpoint setup accepts HTTPS everywhere and HTTP only on loopback or private LAN addresses.

Android notifications use an opt-in foreground live connection for working/idle status, messages, scheduled-task completions, failures, and requests for attention. A future server transport is still required for push delivery while that live connection is disabled. Voice, attachments, and remote-computer transport remain subsequent slices; demo data stays confined to Compose previews and tests.
