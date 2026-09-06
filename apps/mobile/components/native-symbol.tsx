import Ionicons from "@react-native-vector-icons/ionicons";
import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { useMobileTokens } from "../lib/native";

export function NativeSymbol({
  ios,
  android,
  size = 18,
  color,
}: {
  ios: string;
  android: ComponentProps<typeof Ionicons>["name"];
  size?: number;
  color?: ColorValue;
}) {
  const tokens = useMobileTokens();
  const tint = color ?? tokens.foreground;
  return (
    <SymbolView
      name={ios as never}
      size={size}
      tintColor={tint}
      weight="medium"
      resizeMode="scaleAspectFit"
      fallback={<Ionicons name={android} size={size} color={tint} />}
    />
  );
}
