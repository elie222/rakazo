import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { canOfferComputerRestart } from "@rakazo/core";
import type { NativeStackNavigationOptions } from "expo-router";
import { useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Text } from "react-native";
import { computerUpdates } from "../lib/computer-updates";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { GlassIconButton } from "./glass-icon-button";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = Boolean(computer && canOfferComputerRestart(computer));
  const busy = Boolean(computer?.busyBotName) || pending;

  async function restart() {
    if (busy) return;
    setPending(true);
    setError(null);
    try {
      await computerUpdates.start(botId);
      await onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not restart computer`));
    } finally {
      setPending(false);
    }
  }

  useLayoutEffect(() => {
    const label = t`Restart computer`;
    navigation.setOptions(
      (iosAtLeast(26)
        ? {
            unstable_headerRightItems: () =>
              available
                ? [
                    {
                      type: "button" as const,
                      label,
                      accessibilityLabel: label,
                      icon: { type: "sfSymbol" as const, name: "arrow.clockwise" },
                      disabled: busy,
                      onPress: () => void restart(),
                    },
                  ]
                : [],
          }
        : {
            headerRight: available
              ? () => (
                  <GlassIconButton
                    accessibilityLabel={label}
                    ios="arrow.clockwise"
                    android="refresh"
                    disabled={busy}
                    onPress={() => void restart()}
                  />
                )
              : () => null,
          }) satisfies NativeStackNavigationOptions,
    );
    return () => {
      navigation.setOptions(
        iosAtLeast(26) ? { unstable_headerRightItems: () => [] } : { headerRight: () => null },
      );
    };
  }, [navigation, available, busy, t, botId, onChanged]);

  return error ? (
    <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
      {error}
    </Text>
  ) : null;
}
