import type { RunExecutionProfile } from "@rakazo/contracts";
import { EXECUTION_HARNESS_LABELS } from "@rakazo/contracts";
import { Alert } from "react-native";
import { t } from "./i18n";

/** The public run summary is an allowlist; never display a live credential or internal snapshot. */
export function showRunExecutionProfile(profile: RunExecutionProfile) {
  Alert.alert(
    t("Run details"),
    [
      `${t("Execution profile")}: ${profile.name} · v${profile.revision}`,
      `${t("Harness")}: ${EXECUTION_HARNESS_LABELS[profile.harness]}`,
      `${t("Provider")}: ${profile.provider}`,
      `${t("Model")}: ${profile.modelId}`,
      `${t("Account")}: ${profile.accountLabel}`,
    ].join("\n"),
  );
}
