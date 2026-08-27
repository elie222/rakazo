# Rakazo for Android

Native Android client for Rakazo. This project intentionally has its own Gradle build and CI lane; it is not part of the repository's pnpm or Turbo workspaces.

## Requirements

- JDK 17
- Android SDK 37

## Build

```sh
./gradlew assembleDebug
```

The initial vertical slice is local and deterministic: workspace agents, activity, an agent thread, and computer-control state. Server auth, streaming, voice, notifications, and remote-computer transport will be connected through subsequent slices.
