import { Platform } from "react-native";
import { analyticsAppVersion } from "../platform/app-version";

/** Which app this is, as measurement names it. */
function analyticsSurface(): "ios" | "android" | undefined {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : undefined;
}

/** The app and its version, sent with a try at connecting a model. */
export function analyticsClient(): {
  surface?: "ios" | "android";
  appVersion?: string;
} {
  const surface = analyticsSurface();
  if (!surface) return {};
  const appVersion = analyticsAppVersion();
  return { surface, ...(appVersion ? { appVersion } : {}) };
}
