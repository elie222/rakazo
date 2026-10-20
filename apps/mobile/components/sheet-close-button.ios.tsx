import { Button, Host, Image, ZStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

export function SheetCloseButton({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View style={{ width: 30, height: 44 }}>
      <Host
        colorScheme={useResolvedAppearance()}
        ignoreSafeArea="container"
        style={{ width: 44, height: 44, transform: [{ translateX: -7 }] }}
      >
        <Button
          onPress={onPress}
          modifiers={[buttonStyle("plain"), accessibilityLabel(t("Close"))]}
        >
          <ZStack
            modifiers={[
              frame({ width: 30, height: 30 }),
              background(tokens.accent, shapes.circle()),
              frame({ width: 44, height: 44 }),
            ]}
          >
            <Image
              systemName="xmark"
              modifiers={[
                font({ size: 13, weight: "semibold" }),
                foregroundStyle(tokens.mutedForeground),
              ]}
            />
          </ZStack>
        </Button>
      </Host>
    </View>
  );
}
