# Rakazo Android handoff

> Historical initial-scaffold snapshot. Current implementation status is documented in `android-app/README.md` and the git history; upstream review is tracked in PR #378.

## Pickup point

- Fork: https://github.com/luinbytes/rakazo
- Branch: `android-app`
- Initial scaffold commit: `6cd0c9106f7f03730b088079672a9eb95a73a4b6`
- Upstream is `elie222/rakazo`; contribute through the user's fork and upstream PR #378.
- Clone directly with `git clone --branch android-app https://github.com/luinbytes/rakazo.git`.

## Product direction

Build the first-party Android-only Rakazo client in the standalone `android-app/` Gradle project. It deliberately does not use or join the existing Expo, pnpm, or Turbo build graph, so Android can have independent CI.

The selected visual language is **Quiet Instrument**: premium, restrained dark surfaces, dense edge-to-edge lists, semantic cards only for agent/tool events, native Material structure, no bottom navigation, and exact Rakazo organic agent identities. The partial design file is [Rakazo Android — Quiet Instrument](https://www.figma.com/design/UV9Th53pdiLYINEIBrW3tR). Figma automation hit the Starter-plan write quota, so the running Compose app is the most complete current reference.

## What already exists

Read these instead of recreating or restating them:

- Project boundary, requirements, and build command: `android-app/README.md`
- Android-local working rules: `android-app/AGENTS.md`
- Interactive Agents, Activity, thread, and computer-control slice: `android-app/app/src/main/java/com/rakazo/app/ui/RakazoApp.kt`
- Exact port of the shared organic-avatar seed and geometry: `android-app/app/src/main/java/com/rakazo/app/ui/OrganicAvatar.kt`
- Quiet Instrument tokens and typography: `android-app/app/src/main/java/com/rakazo/app/ui/theme/Theme.kt`
- Standalone Android workflow: `.github/workflows/android-app.yml`
- Existing repository CI exclusion for Android-only changes: `.github/workflows/ci.yml`
- Full scaffold diff: commit `6cd0c91`

The initial scaffold used deterministic local demo data. Runtime data is now authenticated server data; preview data remains confined to Compose previews and tests.

## Verified state

- `./gradlew lintDebug testDebugUnitTest assembleDebug` passed with Gradle 9.7.1, JDK 17, and Android SDK 37.
- The APK installed and rendered on an API 35 Pixel emulator at 1080×2400.
- Agents, Activity, thread, computer, and release-control transitions were visually exercised.
- The emulator was shut down after verification.
- The branch was clean when pushed.

## Continue from here

Wait for the user's next concrete feature priority. Voice, attachments, and remote-computer transport remain unconnected product boundaries. Add only the next requested vertical slice; do not scaffold all of these speculatively.

For parity, inspect the existing web/Expo implementations and shared contracts before translating behavior. Keep frontend state thin and put transport/provider translation behind an Android-local boundary. Preserve `com.rakazo.app` and the fixed branded color system; do not enable Material dynamic color.

Before handing work back, run:

```sh
cd android-app
./gradlew lintDebug testDebugUnitTest assembleDebug
```

Use a real Android runtime for any visual or interaction claim. Push task work to the user's fork, not upstream.

## Suggested skills

- `ask-matt` — required by repository guidance for engineering work; route the next concrete slice before editing.
- `mobile-android-design` — Jetpack Compose, Material 3, Android accessibility, and adaptive-layout decisions.
- `product-design:image-to-code` — when translating the selected mockups or Figma reference into Compose.
- `motion-choreography` — when expanding the shared transition and agent-status motion system.
- `verification-before-completion` — fresh Gradle and runtime evidence before claiming a slice complete.
