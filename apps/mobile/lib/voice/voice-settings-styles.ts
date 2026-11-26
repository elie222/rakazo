import { StyleSheet } from "react-native";
import { mobileTokens } from "../appearance/appearance";
import { native } from "../native/native";

export function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    group: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    groupRow: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    groupDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    rowCopy: { flex: 1 },
    cardTitle: { color: native.label, fontSize: 16 },
    fieldLabel: { color: native.label, marginTop: 16 },
    input: {
      marginTop: 8,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
  });
}
