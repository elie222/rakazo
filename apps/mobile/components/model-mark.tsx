import type { ModelMark } from "@rakazo/core";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { NativeSymbol } from "./native-symbol";

/** A model maker's mark in the given color, or a generic chip when the maker has none. */
export function ModelMarkIcon({
  mark,
  size,
  color,
}: {
  mark?: ModelMark;
  size: number;
  color: ColorValue;
}) {
  if (!mark)
    return <NativeSymbol ios="cpu" android="hardware-chip-outline" size={size} color={color} />;
  return (
    <Svg width={size} height={size} viewBox={mark.viewBox} accessible={false}>
      <Path d={mark.path} fill={color} fillRule={mark.evenOdd ? "evenodd" : "nonzero"} />
    </Svg>
  );
}
