import { useHeaderHeight } from "expo-router/react-navigation";
import { iosAtLeast } from "./native-controls";

/** Fixed content has no scroll view to apply the native navigation inset. */
export function useFloatingHeaderInset() {
  const height = useHeaderHeight();
  return iosAtLeast(26) ? height : 0;
}
