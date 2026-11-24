import { AccessibilityInfo } from "react-native";

/** Reads a message out to screen readers when a failure appears without moving focus to it. */
export function announceToScreenReader(message: string): void {
  AccessibilityInfo.announceForAccessibility(message);
}
