import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native } from "../lib/native";

export const INBOX_ROW = { padding: 24, gap: 16, avatarSize: 52 };
export const COMPACT_INBOX_ROW = { padding: 12, gap: 10 };
// Drops the Android create menu below the header circle; the trigger's negative margin keeps the layout.
export const CREATE_MENU_GAP = 6;
/** The header's circle buttons. */
export const HEADER_CIRCLE = 48;
/** The bottom bar's circle and search field, and the space around them. */
export const BOTTOM_BAR = { control: 56, top: 12 };

export function createHomeStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    emptyPane: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      textAlign: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
    },
    headerCircle: {
      width: HEADER_CIRCLE,
      height: HEADER_CIRCLE,
      borderRadius: HEADER_CIRCLE / 2,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    circleButton: {
      flex: 1,
      alignSelf: "stretch",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 999,
      overflow: "hidden",
    },
    createMenuAnchor: {
      height: HEADER_CIRCLE + CREATE_MENU_GAP,
      paddingBottom: CREATE_MENU_GAP,
    },
    profileInitials: {
      color: native.label,
      fontSize: 16,
      fontWeight: fontWeight.medium,
    },
    bottomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      gap: 10,
      paddingTop: BOTTOM_BAR.top,
    },
    searchField: {
      flex: 1,
      height: BOTTOM_BAR.control,
    },
    searchPressable: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      borderRadius: 999,
      overflow: "hidden",
    },
    searchPlaceholder: {
      flex: 1,
      color: native.secondaryLabel,
      fontSize: 18,
      lineHeight: 24,
    },
    error: {
      color: native.secondaryLabel,
      paddingHorizontal: INBOX_ROW.padding,
      paddingBottom: 8,
    },
    listArea: {
      flex: 1,
    },
    list: {
      flexGrow: 1,
      paddingBottom: 32,
    },
    empty: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      paddingHorizontal: INBOX_ROW.padding,
      paddingTop: 28,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: INBOX_ROW.padding,
      paddingVertical: 12,
      gap: INBOX_ROW.gap,
    },
    rowSelected: {
      marginHorizontal: 12,
      paddingHorizontal: INBOX_ROW.padding - 12,
      borderRadius: 22,
      backgroundColor: native.fillPressed,
    },
    pinnedTiles: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      paddingHorizontal: 8,
      paddingTop: 12,
      paddingBottom: 20,
    },
    pinnedTile: {
      width: "33.33%",
      alignItems: "center",
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderRadius: 22,
      gap: 10,
    },
    pinnedLabel: {
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    pinnedName: {
      flexShrink: 1,
      color: native.label,
      ...typeScale.body,
      lineHeight: 22,
      textAlign: "center",
      writingDirection: "auto",
    },
    compactRow: {
      paddingHorizontal: COMPACT_INBOX_ROW.padding,
      gap: COMPACT_INBOX_ROW.gap,
    },
    rowPressed: {
      opacity: 0.55,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    titleRow: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    rowBottom: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    name: {
      flexShrink: 0,
      maxWidth: "100%",
      color: native.label,
      ...typeScale.cardTitle,
      fontWeight: fontWeight.regular,
      writingDirection: "auto",
    },
    unreadName: {
      fontWeight: fontWeight.medium,
    },
    time: {
      color: native.secondaryLabel,
      ...typeScale.caption,
    },
    preview: {
      flex: 1,
      color: native.secondaryLabel,
      ...typeScale.secondary,
      writingDirection: "auto",
    },
    unreadPreview: {
      color: native.label,
    },
    unreadDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: tokens.unread,
    },
    spaceHeading: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: INBOX_ROW.padding,
      paddingTop: 8,
    },
    spaceSelect: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
    },
    spaceTitle: {
      color: native.label,
      ...typeScale.secondary,
      fontWeight: fontWeight.medium,
      writingDirection: "auto",
    },
    spaceActions: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    recoveryAction: {
      minHeight: 44,
      paddingHorizontal: INBOX_ROW.padding,
      justifyContent: "center",
    },
    sectionHeadingRow: { flexDirection: "row", alignItems: "center", paddingRight: 16 },
    sectionToggle: {
      flex: 1,
      alignSelf: "stretch",
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: INBOX_ROW.padding,
      paddingTop: 10,
      paddingBottom: 6,
    },
    archivedRow: { flex: 0, width: "100%" },
    sectionTitle: {
      flexShrink: 1,
      color: native.secondaryLabel,
      ...typeScale.body,
      lineHeight: 22,
    },
    sectionCount: {
      color: native.tertiaryLabel,
      ...typeScale.caption,
      fontVariant: ["tabular-nums"],
    },
    activitySection: {
      marginBottom: 4,
      paddingBottom: 4,
    },
  });
}
