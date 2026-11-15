import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native } from "../lib/native";

/** Styles shared by the model connection screen and its parts. */
export function createModelsStyles() {
  const tokens = mobileTokens();
  const raised = {
    backgroundColor: tokens.card,
    borderWidth: 1,
    borderColor: tokens.glassStroke,
  } as const;
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      width: "100%",
      paddingHorizontal: 20,
      paddingTop: 16,
      gap: 12,
      paddingBottom: 40,
    },
    secondary: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      marginTop: 4,
    },
    sectionTitle: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      paddingStart: 20,
      marginTop: 12,
      marginBottom: 2,
    },
    card: {
      borderRadius: 22,
      borderCurve: "continuous",
      ...raised,
      overflow: "hidden",
    },
    providerCopy: {
      flex: 1,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 8,
      marginBottom: 16,
    },
    modelRow: {
      minHeight: 60,
      paddingHorizontal: 20,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      borderBottomColor: native.separator,
    },
    modelRowChoice: {
      flex: 1,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 18,
      lineHeight: 24,
    },
    singleRow: {
      borderBottomWidth: 0,
    },
    hint: {
      color: native.secondaryLabel,
      ...typeScale.caption,
      marginTop: 4,
    },
    textAction: {
      color: native.secondaryLabel,
      fontSize: 16,
      marginTop: 8,
    },
    oauthCard: {
      borderRadius: 22,
      borderCurve: "continuous",
      ...raised,
      padding: 20,
      marginTop: 8,
    },
    link: {
      color: native.label,
      fontSize: 16,
      textDecorationLine: "underline",
      marginTop: 6,
    },
    code: {
      color: native.label,
      fontFamily: "monospace",
      fontSize: 24,
      letterSpacing: 3,
      marginTop: 10,
      marginBottom: 2,
    },
    nestedInput: {
      // The OAuth card is already a fill; the page color keeps the field visible on it.
      backgroundColor: native.page,
    },
    keySection: {
      marginTop: 4,
    },
    keyInput: {
      minHeight: 56,
      borderRadius: 28,
      ...raised,
      color: native.label,
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginTop: 4,
      fontSize: 17,
    },
    error: {
      color: tokens.destructive,
      ...typeScale.caption,
      marginTop: 4,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
