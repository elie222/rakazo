import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { transparentColor } from "../lib/color";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";

export function createThreadHeaderStyles() {
  const tokens = mobileTokens();
  const transparentBackground = transparentColor(tokens.background);
  return StyleSheet.create({
    titleCapsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      maxWidth: 220,
      minHeight: HEADER_CONTROL_SIZE,
      paddingHorizontal: 14,
      borderRadius: 999,
    },
    titleCapsuleFill: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      backgroundColor: tokens.card,
    },
    title: {
      color: tokens.foreground,
      fontSize: 18,
      fontWeight: "600",
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
      borderColor: tokens.border,
      backgroundColor: tokens.card,
    },
    composerFade: {
      position: "absolute",
      bottom: "100%",
      left: -20,
      right: -20,
      height: 24,
      experimental_backgroundImage: `linear-gradient(to top, ${tokens.background} 0%, ${transparentBackground} 100%)`,
    },
  });
}
