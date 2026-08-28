# Rakazo for Android

Native Android client for Rakazo. This project intentionally has its own Gradle build and CI lane; it is not part of the repository's pnpm or Turbo workspaces.

## Requirements

- JDK 17
- Android SDK 37

## Build

```sh
./gradlew assembleDebug
```

The app connects to a self-hosted Rakazo server, stores its Better Auth session with an Android Keystore key, and renders the authenticated workspace agent list. Endpoint setup accepts HTTPS everywhere and HTTP only on loopback or private LAN addresses.

Activity, thread streaming, voice, notifications, attachments, and remote-computer transport remain subsequent slices. Their deterministic UI reference stays in Compose previews rather than appearing as runtime data.
