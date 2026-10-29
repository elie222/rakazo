import { typeScale } from "@rakazo/ui-tokens";
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
    statusBarFade: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      experimental_backgroundImage: `linear-gradient(to bottom, ${tokens.background} 0%, ${tokens.background} 60%, ${transparentBackground} 100%)`,
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
