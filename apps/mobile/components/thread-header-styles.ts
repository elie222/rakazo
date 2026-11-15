import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";

/** The chat header's own controls: the circle buttons and the title pill between them. */
export const CHAT_HEADER_CONTROL_SIZE = 48;

export function createThreadHeaderStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    titleCapsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: CHAT_HEADER_CONTROL_SIZE,
      // 8 and 20 from the pill's outer edge, inside its 1pt border.
      paddingStart: 7,
      paddingEnd: 19,
      borderRadius: 999,
    },
    hug: { flexDirection: "row" },
    hugged: { flexShrink: 1 },
    // A group's pill: 8 and 18 from its edge, 12 between the stack and the name.
    groupCapsule: { gap: 12, paddingEnd: 17 },
    // The creatures never shrink; only the name gives way.
    stack: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
    more: {
      marginStart: 4,
      fontSize: 21,
      fontWeight: "500",
      color: tokens.faintForeground,
    },
    titleColumn: { flex: 1, minWidth: 0 },
    title: {
      // A long name gives way to the avatars beside it and ends in "…".
      flexShrink: 1,
      ...typeScale.cardTitle,
      color: tokens.foreground,
    },
    // Above a status line the name tightens to 18/22 so both fit the 48pt pill.
    groupTitle: {
      ...typeScale.cardTitle,
      lineHeight: 22,
      color: tokens.foreground,
    },
    status: {
      fontSize: 13,
      lineHeight: 16,
      color: tokens.mutedForeground,
    },
    statusRow: { flexDirection: "row", minWidth: 0 },
    // Only the name shrinks and ends in "…"; the words around it keep their room.
    statusName: { flexShrink: 1 },
  });
}
