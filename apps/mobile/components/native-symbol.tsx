import Ionicons from "@react-native-vector-icons/ionicons";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import type { SymbolWeight } from "expo-symbols";
import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { useMobileTokens } from "../lib/native";

export function NativeSymbol({
  ios,
  android,
  size = 18,
  color,
  weight = "medium",
}: {
  ios: string;
  /** An Ionicons name, or a Material Design icon for glyphs Ionicons lacks. */
  android:
    | ComponentProps<typeof Ionicons>["name"]
    | { material: ComponentProps<typeof MaterialDesignIcons>["name"] };
  size?: number;
  weight?: SymbolWeight;
  color?: ColorValue;
}) {
  const tokens = useMobileTokens();
  const tint = color ?? tokens.foreground;
  return (
    <SymbolView
      name={ios as never}
      size={size}
      tintColor={tint}
      weight={weight}
      resizeMode="scaleAspectFit"
      fallback={
        typeof android === "string" ? (
          <Ionicons name={android} size={size} color={tint} />
        ) : (
          <MaterialDesignIcons name={android.material} size={size} color={tint} />
        )
      }
    />
  );
}
