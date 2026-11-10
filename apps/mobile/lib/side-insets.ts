import { createContext, useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** True for screens the split frame lays out beside the chat list, never for sheets over it. */
export const InboxBesideContext = createContext(false);

/**
 * Scroll view padding that keeps content clear of side bars, cutouts and the iPhone Duo outer
 * display's status bar while the background still runs edge to edge. Beside the chat list the
 * left edge is already clear.
 */
export function useSideInsets() {
  const insets = useSafeAreaInsets();
  const besideInbox = useContext(InboxBesideContext);
  return { paddingLeft: besideInbox ? 0 : insets.left, paddingRight: insets.right };
}
