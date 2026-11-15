import { useLingui } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { BOT_COMPUTER_MODES } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { NativeSegmentedControl } from "./native-segmented-control";

export function ComputerModePicker({
  value,
  onChange,
  disabled = false,
  plain = false,
}: {
  value: ComputerMode | undefined;
  onChange: (mode: ComputerMode) => void;
  disabled?: boolean;
  plain?: boolean;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <View
      style={
        plain
          ? { gap: 8 }
          : {
              marginTop: 16,
              padding: 18,
              borderRadius: 22,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
            }
      }
    >
      {!plain ? (
        <Text
          style={
            plain
              ? { color: tokens.mutedForeground, fontSize: 14 }
              : {
                  color: tokens.foreground,
                  marginBottom: 12,
                  ...typeScale.secondary,
                  fontWeight: "500",
                }
          }
        >
          {t`Computer`}
        </Text>
      ) : null}
      <NativeSegmentedControl
        accessibilityLabel={t`Computer`}
        disabled={disabled}
        onChange={onChange}
        options={BOT_COMPUTER_MODES.map((value) => ({
          value,
          label: value === "team" ? t`Team` : t`Private`,
        }))}
        value={value}
      />
    </View>
  );
}
