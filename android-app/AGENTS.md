# Android app guidance

- This directory is a standalone Gradle project. Do not add it to pnpm, Turbo, Expo, or the web build graph.
- Keep product contracts compatible with Rakazo's shared API, but implement the transport behind an Android-local boundary instead of importing TypeScript packages.
- Build UI with Jetpack Compose and the fixed Quiet Instrument theme. Do not enable dynamic color: agent identity colors and dark surfaces are product semantics.
- Preserve the shared organic-avatar identity algorithm when changing avatars.
- Run `./gradlew lintDebug testDebugUnitTest assembleDebug` before handoff.
