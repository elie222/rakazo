import type { ComputerMode } from "@rakazo/contracts";
import { BOT_COMPUTER_MODES } from "@rakazo/contracts";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
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
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View
      style={
        plain
          ? { gap: 8 }
          : { marginTop: 16, padding: 16, borderRadius: 14, backgroundColor: native.fill }
      }
    >
      {!plain ? (
        <Text
          style={
            plain
              ? { color: tokens.mutedForeground, fontSize: 14 }
              : { color: tokens.foreground, marginBottom: 12, fontSize: 16, fontWeight: "600" }
          }
        >
          {t("Computer")}
        </Text>
      ) : null}
      <NativeSegmentedControl
        accessibilityLabel={t("Computer")}
        disabled={disabled}
        onChange={onChange}
        options={BOT_COMPUTER_MODES.map((value) => ({
          value,
          label: value === "team" ? t("Team") : t("Private"),
        }))}
        value={value}
      />
    </View>
  );
}
