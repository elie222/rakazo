import { native } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

/** Skills always share one document mark, so they never read as apps. */
export function SkillSymbol({ size = 15 }: { size?: number }) {
  return (
    <NativeSymbol
      android="document-text-outline"
      color={native.secondaryLabel}
      ios="doc.text"
      size={size}
    />
  );
}
