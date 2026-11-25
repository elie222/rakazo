import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { View } from "react-native";

type ComposerKeyboardProps = {
  children: ReactNode;
  style: ViewProps["style"];
  enterEnabled: boolean;
  commandEnterEnabled: boolean;
  pickerOpen: boolean;
  onHardwareKey: (event: { nativeEvent: { key: string } }) => void;
};

const NativeComposerKeyboard = requireOptionalNativeModule("RakazoComposerKeyboard")
  ? requireNativeView<ComposerKeyboardProps>("RakazoComposerKeyboard")
  : null;

export const supportsComposerHardwareEnter = NativeComposerKeyboard !== null;

export function ComposerKeyboard(props: ComposerKeyboardProps) {
  return NativeComposerKeyboard ? (
    <NativeComposerKeyboard {...props} />
  ) : (
    <View style={props.style}>{props.children}</View>
  );
}
