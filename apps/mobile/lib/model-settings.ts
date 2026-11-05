import { router } from "expo-router";
import { Alert } from "react-native";
import { t } from "./i18n";

export function openModelSettings() {
  router.push("/(settings)/models");
}

/** Offers Models where nothing can run until the account has a model. */
export function askToAddModel() {
  Alert.alert(t("Add an AI model to keep chatting"), undefined, [
    { text: t("Not Now"), style: "cancel" },
    { text: t("Add model"), onPress: openModelSettings, isPreferred: true },
  ]);
}
