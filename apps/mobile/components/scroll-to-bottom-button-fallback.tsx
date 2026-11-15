import { GlassIconButton } from "./glass-icon-button";

export type ScrollToBottomButtonProps = {
  accessibilityLabel: string;
  onPress: () => void;
};

export function ScrollToBottomButtonFallback({
  accessibilityLabel,
  onPress,
}: ScrollToBottomButtonProps) {
  return (
    <GlassIconButton
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      ios="chevron.down"
      android="chevron-down"
    />
  );
}
