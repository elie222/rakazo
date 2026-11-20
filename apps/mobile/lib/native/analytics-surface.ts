import { Platform } from "react-native";

/** Which app this is, as measurement names it. */
export function analyticsSurface(): "ios" | "android" | undefined {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : undefined;
}
