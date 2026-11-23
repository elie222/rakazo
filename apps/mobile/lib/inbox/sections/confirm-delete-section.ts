import { ph, t } from "@lingui/core/macro";
import { Alert } from "react-native";

export function confirmDeleteSection(section: { id: string; name: string }, onDelete: () => void) {
  Alert.alert(
    t`Delete ${ph({ name: section.name })}?`,
    t`Its bots and groups are kept and leave the section.`,
    [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Delete`, style: "destructive", onPress: onDelete },
    ],
  );
}
