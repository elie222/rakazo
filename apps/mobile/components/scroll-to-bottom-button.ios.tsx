import { Button, Host } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { ScrollToBottomButtonProps } from "./scroll-to-bottom-button-fallback";
import { ScrollToBottomButtonFallback } from "./scroll-to-bottom-button-fallback";

export function ScrollToBottomButton(props: ScrollToBottomButtonProps) {
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  if (!iosAtLeast(26)) return <ScrollToBottomButtonFallback {...props} />;
  return (
    <Host matchContents colorScheme={scheme} ignoreSafeArea="container">
      <Button
        label={props.accessibilityLabel}
        systemImage="chevron.down"
        onPress={props.onPress}
        modifiers={[
          buttonStyle("glass"),
          buttonBorderShape("circle"),
          controlSize("large"),
          labelStyle("iconOnly"),
          tint(tokens.foreground),
          accessibilityLabel(props.accessibilityLabel),
        ]}
      />
    </Host>
  );
}
