import type { ViewModifier } from "@expo/ui/swift-ui/modifiers";
import { createContext } from "react";

/**
 * Set while a row renders as a row of a native list (the iOS inbox), with the row modifiers that
 * list gives each row. A swipe row then joins that list directly instead of hosting a list of
 * its own. Hosted React Native content resets it, so rows nested inside stay self-contained.
 */
export const NativeListRowContext = createContext<{
  modifiers: ViewModifier[];
  /** The row's content width, once the list has laid it out. */
  width?: number;
} | null>(null);
