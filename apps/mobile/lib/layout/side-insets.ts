import { createContext, useContext } from "react";
import { Platform } from "react-native";
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

/**
 * Padding for a page sheet's root view. iOS page sheets already clear the notch, while Android
 * modals are full-screen. The sides keep the header buttons and fields clear of cutouts and of
 * the iPhone Duo outer display's status bar, which runs down one edge with the sheet beside it.
 */
export function useSheetPadding() {
  const insets = useSafeAreaInsets();
  return {
    paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  };
}
