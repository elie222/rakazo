import { useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CallKeyboardContext } from "./call-keyboard-context";

export function useContentBottomInset(): number {
  const rootOwnsBottom = useContext(CallKeyboardContext);
  const insets = useSafeAreaInsets();
  return rootOwnsBottom ? 0 : insets.bottom;
}
