import type Ionicons from "@react-native-vector-icons/ionicons";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { native } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

type TemplateSymbol = { ios: string; android: ComponentProps<typeof Ionicons>["name"] };

const SYMBOLS: Record<string, TemplateSymbol> = {
  "morning-briefing": { ios: "sun.max", android: "sunny-outline" },
  "inbox-triage": { ios: "tray", android: "file-tray-outline" },
  "pr-reviewer": { ios: "arrow.triangle.pull", android: "git-pull-request-outline" },
  "topic-watch": { ios: "binoculars", android: "telescope-outline" },
};

/** The mark for bot templates as a whole. */
export const BOT_TEMPLATES_SYMBOL: TemplateSymbol = {
  ios: "square.grid.2x2",
  android: "grid-outline",
};

/** A template's mark in a rounded tile; unknown templates share the templates mark. */
export function BotTemplateIcon({ id, size = 32 }: { id?: string; size?: number }) {
  const symbol = (id && SYMBOLS[id]) || BOT_TEMPLATES_SYMBOL;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderCurve: "continuous",
        backgroundColor: native.fillPressed,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <NativeSymbol {...symbol} size={Math.round(size * 0.5)} color={native.label} />
    </View>
  );
}
