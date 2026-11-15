import { StyleSheet } from "react-native";
import { mobileTokens } from "./appearance";
import { native } from "./native";

/** The grouped page the settings hub and its General and Account pages share. */
export function createSettingsPageStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.groupedPage,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
      gap: 24,
    },
    compactContent: {
      paddingHorizontal: 8,
    },
    section: {
      gap: 8,
    },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
  });
}
