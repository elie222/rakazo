import type { ReactElement } from "react";
import { ScrollViewMarker } from "react-native-screens/experimental";
import { iosAtLeast } from "../lib/native-controls";
import { threadScrollEdgeEffects } from "../lib/thread-edges";

/** Key this with its single scroll child: the marker configures native edges on mount. */
export function ThreadScrollSurface({ children }: { children: ReactElement }) {
  if (!iosAtLeast(26)) return children;
  // Screen options only find the first descendant chain and miss later scroll mounts.
  // The marker targets this scroll view directly; hidden edges persist through keyboard layout.
  return (
    <ScrollViewMarker style={{ flex: 1 }} scrollEdgeEffects={threadScrollEdgeEffects}>
      {children}
    </ScrollViewMarker>
  );
}
