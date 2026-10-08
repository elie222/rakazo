import { Button, Host } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  controlSize,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { t } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";

export function ReplyDismissButton({ onPress }: { onPress: () => void }) {
  return (
    <Host matchContents colorScheme={useResolvedAppearance()} ignoreSafeArea="container">
      <Button
        label={t("Cancel reply")}
        systemImage="xmark.circle.fill"
        onPress={onPress}
        modifiers={[
          buttonStyle("plain"),
          controlSize("small"),
          labelStyle("iconOnly"),
          accessibilityLabel(t("Cancel reply")),
        ]}
      />
    </Host>
  );
}
