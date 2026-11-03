import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native } from "../lib/native";

export const INBOX_ROW = { padding: 16, gap: 12, avatarSize: 62 };
export const COMPACT_INBOX_ROW = { padding: 12, gap: 10 };
// Drops the Android create menu below the header pill; the trigger's negative margin keeps the layout.
export const CREATE_MENU_GAP = 6;

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
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      padding: 2,
      borderRadius: 22,
      backgroundColor: native.fillPressed,
    },
    circleButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fillPressed,
    },
    headerButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    createMenuAnchor: {
      height: 40 + CREATE_MENU_GAP,
      paddingBottom: CREATE_MENU_GAP,
    },
    headerButtonActive: {
      backgroundColor: native.fill,
    },
    headerButtonAccent: {
      backgroundColor: tokens.primary,
    },
    profileInitials: {
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
    },
    error: {
      color: native.secondaryLabel,
      paddingHorizontal: 20,
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
      fontSize: 16,
      paddingHorizontal: 20,
      paddingTop: 28,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: INBOX_ROW.padding,
      paddingVertical: 14,
      gap: INBOX_ROW.gap,
    },
    rowSelected: {
      marginHorizontal: 12,
      paddingHorizontal: 4,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
    },
    pinnedTiles: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: 8,
      paddingTop: 4,
      paddingBottom: 12,
    },
    pinnedTile: {
      width: "33.33%",
      alignItems: "center",
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderRadius: 16,
      gap: 4,
    },
    pinnedName: {
      color: native.secondaryLabel,
      fontSize: 13,
      fontWeight: "500",
      textAlign: "center",
      writingDirection: "auto",
    },
    pinnedUnread: {
      color: native.label,
      fontWeight: "700",
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
      alignItems: "flex-start",
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
    rowMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    name: {
      flexShrink: 0,
      maxWidth: "100%",
      color: native.label,
      ...typeScale.cardTitle,
      writingDirection: "auto",
    },
    time: {
      color: native.tertiaryLabel,
      ...typeScale.caption,
    },
    preview: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      writingDirection: "auto",
    },
    unreadPreview: {
      color: native.label,
      fontWeight: "600",
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: tokens.unread,
    },
    spaceHeading: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    spaceSelect: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
    },
    spaceTitle: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
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
      paddingHorizontal: 20,
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
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    archivedRow: { flex: 0, width: "100%" },
    sectionTitle: {
      flexShrink: 1,
      color: native.secondaryLabel,
      ...typeScale.secondary,
    },
    sectionCount: {
      color: native.tertiaryLabel,
      ...typeScale.caption,
      fontVariant: ["tabular-nums"],
    },
    sectionHeading: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    activitySection: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
      marginBottom: 4,
      paddingBottom: 4,
    },
    activityGap: {
      paddingTop: 16,
    },
    groupAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    groupAvatarLabel: {
      color: native.secondaryLabel,
      fontSize: 16,
      fontWeight: "600",
    },
  });
}
