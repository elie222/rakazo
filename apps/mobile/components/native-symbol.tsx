import Ionicons from "@react-native-vector-icons/ionicons";
import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";

export function NativeSymbol({
  ios,
  android,
  size = 18,
  color = "#fff",
}: {
  ios: string;
  android: ComponentProps<typeof Ionicons>["name"];
  size?: number;
  color?: ColorValue;
}) {
  return (
    <SymbolView
      name={ios as never}
      size={size}
      tintColor={color}
      weight="medium"
      resizeMode="scaleAspectFit"
      fallback={<Ionicons name={android} size={size} color={color} />}
    />
  );
}
