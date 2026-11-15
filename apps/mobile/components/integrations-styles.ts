import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native } from "../lib/native";

export const LOGO_SIZE = 32;

/** Styles shared by the integrations screen and its parts. */
export function createIntegrationsStyles() {
  const tokens = mobileTokens();
  const destructive = tokens.destructive;
  const raised = {
    backgroundColor: tokens.card,
    borderWidth: 1,
    borderColor: tokens.glassStroke,
  } as const;
  return StyleSheet.create({
    connectionStatus: { flexDirection: "row", alignItems: "center", gap: 4 },
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingHorizontal: 20, paddingVertical: 16, gap: 16 },
    explanation: { color: native.secondaryLabel, ...typeScale.secondary },
    section: { color: native.secondaryLabel, ...typeScale.secondary, marginTop: 4 },
    card: { padding: 20, borderRadius: 22, borderCurve: "continuous", gap: 14, ...raised },
    input: {
      minHeight: 56,
      borderRadius: 28,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 20,
      fontSize: 17,
    },
    catalogGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    catalogStack: { gap: 8 },
    catalogCell: { flexGrow: 1, flexBasis: "47%", maxWidth: "49%" },
    row: {
      minHeight: 64,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 22,
      borderCurve: "continuous",
      ...raised,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    logoPlaceholder: {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
    },
    titlePlaceholder: {
      width: "65%",
      height: 14,
      borderRadius: 4,
      backgroundColor: native.fillPressed,
    },
    pillPlaceholder: {
      width: 52,
      height: 30,
      borderRadius: 15,
      backgroundColor: native.fillPressed,
    },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    title: { color: native.label, ...typeScale.cardTitle },
    secondary: { color: native.secondaryLabel, ...typeScale.caption },
    pressed: { backgroundColor: tokens.accent },
    categoryPicker: { alignSelf: "flex-start" },
    sectionHeader: {
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitle: { color: native.label, ...typeScale.headline },
    accountActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    accountRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    accountLabel: {
      flex: 1,
      minHeight: 44,
      borderRadius: 22,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 16,
      fontSize: 15,
    },
    link: { color: native.label, fontSize: 16, fontWeight: "500" },
    error: { color: destructive, ...typeScale.caption },
    detail: { gap: 16 },
    detailHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    detailTitleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
    backButton: { paddingVertical: 4 },
    detailTitle: { flex: 1, color: native.label, ...typeScale.headline },
    toolsToggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    toolsBody: { gap: 8, paddingTop: 4 },
    toolName: { color: native.label, ...typeScale.caption },
    addCustom: { alignSelf: "flex-end", padding: 12 },
  });
}
