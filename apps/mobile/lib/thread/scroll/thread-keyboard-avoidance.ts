import { Platform } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useAnimatedStyle } from "react-native-reanimated";

export function useThreadKeyboardAvoidance({
  rootAvoidsKeyboard,
  floatingHeader,
  nativeHeaderHeight,
}: {
  rootAvoidsKeyboard: boolean;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
}) {
  const { height } = useReanimatedKeyboardAnimation();
  const android = Platform.OS === "android";
  const padForKeyboard = android && !rootAvoidsKeyboard;
  const keyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: padForKeyboard ? Math.max(0, -height.value) : 0,
  }));

  return {
    enabled: !android && !rootAvoidsKeyboard,
    keyboardVerticalOffset: Platform.OS === "ios" && !floatingHeader ? nativeHeaderHeight : 0,
    keyboardPadding,
  };
}
