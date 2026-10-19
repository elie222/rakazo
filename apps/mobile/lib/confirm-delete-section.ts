import { Alert } from "react-native";
import type { t as translate } from "./i18n";

export function confirmDeleteSection(
  section: { id: string; name: string },
  t: typeof translate,
  onDelete: () => void,
) {
  Alert.alert(
    t("Delete {name}?", { name: section.name }),
    t("Its bots and groups are kept and leave the section."),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Delete"), style: "destructive", onPress: onDelete },
    ],
  );
}
