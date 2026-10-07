import { MenuView } from "@expo/ui/community/menu";
import type { ComputerStatus } from "@rakazo/contracts";
import type { NativeStackNavigationOptions } from "expo-router";
import { useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const navigation = useNavigation();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = Boolean(computer?.busyBotName) || computer?.state === "booting" || pending !== null;

  async function run(action: Action) {
    if (busy) return;
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc("computer/reset", { botId });
      else await computerUpdates.start(botId);
      await onChanged();
    } catch (err) {
      setError(errorText(err, t("Could not update computer")));
    } finally {
      setPending(null);
    }
  }

  function confirm(action: "recover" | "reset") {
    Alert.alert(
      action === "reset" ? t("Reset computer?") : t("Recover computer?"),
      action === "reset"
        ? t("Restore the last saved workspace. Unsaved work on the computer is lost.")
        : t("Recovery restores the last saved workspace. Unsaved work may be lost."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: action === "reset" ? t("Reset") : t("Recover computer"),
          style: "destructive",
          onPress: () => void run(action),
        },
      ],
    );
  }

  const actions = [
    {
      id: "recover",
      title: t("Recover computer"),
      explanation: t("Recreate a computer that is not working."),
      destructive: false,
      onPress: () => confirm("recover"),
    },
    {
      id: "reset",
      title: t("Reset computer"),
      explanation: t("Restore the last saved workspace."),
      destructive: true,
      onPress: () => confirm("reset"),
    },
    ...(computer?.canUpdate
      ? [
          {
            id: "update",
            title: t("Update computer"),
            explanation: t("Save the workspace and install current software."),
            destructive: false,
            onPress: () => void run("update"),
          },
        ]
      : []),
  ];

  const hasComputer = computer !== null;
  const canUpdate = Boolean(computer?.canUpdate);
  useLayoutEffect(() => {
    if (!iosAtLeast(26)) return;
    navigation.setOptions({
      unstable_headerRightItems: () =>
        computer
          ? [
              {
                type: "menu" as const,
                label: t("More computer actions"),
                accessibilityLabel: t("More computer actions"),
                icon: { type: "sfSymbol" as const, name: "ellipsis" },
                menu: {
                  items: actions.map((action) => ({
                    type: "action" as const,
                    label: action.title,
                    description: action.explanation,
                    destructive: action.destructive,
                    disabled: busy,
                    onPress: action.onPress,
                  })),
                },
              },
            ]
          : [],
    } satisfies NativeStackNavigationOptions);
    return () => {
      navigation.setOptions({ unstable_headerRightItems: () => [] });
    };
  }, [navigation, hasComputer, canUpdate, busy, t, botId, onChanged]);

  if (!computer) return null;
  return (
    <View>
      {!iosAtLeast(26) ? (
        <MenuView
          colorScheme={scheme}
          title={t("More computer actions")}
          actions={actions.map((action) => ({
            id: action.id,
            title: action.explanation,
            displayInline: true,
            subactions: [
              {
                id: action.id,
                title: action.title,
                attributes: { destructive: action.destructive, disabled: busy },
              },
            ],
          }))}
          onPressAction={({ nativeEvent }) =>
            actions.find((action) => action.id === nativeEvent.event)?.onPress()
          }
        >
          <View
            accessibilityRole="button"
            accessibilityLabel={t("More computer actions")}
            style={{ alignSelf: "flex-end", padding: 12 }}
          >
            <NativeSymbol
              ios="ellipsis"
              android="ellipsis-horizontal"
              color={tokens.foreground}
              size={22}
            />
          </View>
        </MenuView>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
