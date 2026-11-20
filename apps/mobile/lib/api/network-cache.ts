import { requireOptionalNativeModule } from "expo-modules-core";

// iOS only: absent on Android, on web, and in binaries built before the module existed.
const nativeCache = requireOptionalNativeModule<{ clear(): void }>("RakazoNetworkCache");

/** The app never reads the system HTTP cache or cookies back, so neither should outlive a session. */
export function clearNetworkCache() {
  nativeCache?.clear();
}
