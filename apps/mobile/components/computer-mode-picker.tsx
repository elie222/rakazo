import type { ComputerMode } from "@rakazo/contracts";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

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
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: tokens.mutedForeground, marginBottom: 8, fontSize: 14 }}>
        {t("Computer")}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["team", "dedicated"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: value === mode }}
            disabled={disabled}
            onPress={() => onChange(mode)}
            style={{
              flex: 1,
              alignItems: "center",
              borderWidth: 1,
              borderColor: value === mode ? tokens.mutedForeground : tokens.border,
              backgroundColor: value === mode ? tokens.muted : "transparent",
              borderRadius: 11,
              paddingVertical: 12,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: value === mode ? tokens.foreground : tokens.mutedForeground }}>
              {mode === "team" ? t("Team") : t("Private")}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
