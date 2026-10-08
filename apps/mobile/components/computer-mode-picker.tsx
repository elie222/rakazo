import type { ComputerMode } from "@rakazo/contracts";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeSegmentedControl } from "./native-segmented-control";

export function ComputerModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ComputerMode | undefined;
  onChange: (mode: ComputerMode) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View style={{ marginTop: 16, padding: 16, borderRadius: 14, backgroundColor: native.fill }}>
      <Text style={{ color: tokens.foreground, marginBottom: 12, fontSize: 16, fontWeight: "600" }}>
        {t("Computer")}
      </Text>
      <NativeSegmentedControl
        accessibilityLabel={t("Computer")}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "team", label: t("Team") },
          { value: "dedicated", label: t("Private") },
        ]}
        value={value}
      />
    </View>
  );
}
