import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";

export function createThreadHeaderStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    titleCapsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      maxWidth: 220,
      minHeight: HEADER_CONTROL_SIZE,
      paddingStart: 14,
      paddingEnd: 10,
      borderRadius: 999,
    },
    titleCapsuleFill: {
      backgroundColor: tokens.glassFill,
    },
    title: {
      // A long name gives way to the avatars beside it and ends in "…".
      flexShrink: 1,
      ...typeScale.cardTitle,
      color: tokens.foreground,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 20,
    },
    circleButton: {
      flex: 1,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
    },
    composerFill: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.glassStroke,
      backgroundColor: tokens.glassFill,
    },
  });
}
