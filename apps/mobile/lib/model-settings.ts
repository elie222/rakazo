import { router } from "expo-router";
import { Alert } from "react-native";
import { t } from "./i18n";

export function openModelSettings(spaceId?: string) {
  router.push(
    spaceId ? { pathname: "/(settings)/models", params: { spaceId } } : "/(settings)/models",
  );
}

export function askToAddModel(spaceId?: string) {
  Alert.alert(t("Add an AI model to keep chatting"), undefined, [
    { text: t("Not Now"), style: "cancel" },
    { text: t("Add model"), onPress: () => openModelSettings(spaceId), isPreferred: true },
  ]);
}
