import type { RoutineRun } from "@rakazo/contracts";
import { formatRoutineRunAt } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { activityStatusLabel } from "../lib/activity";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { routineRunDestination, useRoutineRuns } from "../lib/routine-runs";
import { NativeActionButton } from "./native-action-button";
import { RunErrorSheet, useRunError } from "./run-error-sheet";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function RoutineRunHistory({
  routineId,
  botName,
}: {
  routineId: string;
  botName: string | undefined;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const history = useRoutineRuns(routineId);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  if (!history.runs) {
    if (!history.failed) return <ActivityIndicator color={native.secondaryLabel} />;
    return (
      <>
        <SettingsGroup label={t("Run history")}>
          <SettingsRow key="failed" title={t("Could not load run history")} dimmed />
        </SettingsGroup>
        <NativeActionButton
          label={t("Try Again")}
          variant="text"
          prominence="secondary"
          onPress={history.retry}
        />
      </>
    );
  }
  return (
    <>
      <SettingsGroup label={t("Run history")}>
        {history.runs.length === 0 ? (
          <SettingsRow key="empty" title={t("No runs yet")} dimmed />
        ) : (
          history.runs.map((run) => {
            const destination = routineRunDestination(run, botName);
            const error = run.status === "failed" ? run.error : null;
            return (
              <RunRow
                key={run.id}
                run={run}
                error={error}
                onPress={
                  destination
                    ? () => router.push(destination)
                    : error
                      ? () => setErrorDetails(error)
                      : undefined
                }
              />
            );
          })
        )}
        {history.failed ? (
          <SettingsRow key="failed" title={t("Could not load run history")} dimmed />
        ) : null}
      </SettingsGroup>
      {history.hasOlder ? (
        <NativeActionButton
          label={t("Load older runs")}
          variant="text"
          prominence="secondary"
          busy={history.loadingOlder}
          onPress={history.loadOlder}
        />
      ) : null}
      <RunErrorSheet details={errorDetails} onClose={() => setErrorDetails(null)} />
    </>
  );
}

function RunRow({
  run,
  error,
  onPress,
}: {
  run: RoutineRun;
  error: string | null;
  onPress: (() => void) | undefined;
}) {
  const { locale, t } = useI18n();
  const failure = useRunError(error);
  const title = formatRoutineRunAt(run, dateLocaleForUi(locale));
  return (
    <SettingsRow
      accessibilityRole={onPress ? "button" : undefined}
      title={title}
      detail={failure?.summary}
      value={
        run.status !== "completed"
          ? activityStatusLabel(run.status)
          : run.messageId
            ? undefined
            : t("No reply")
      }
      chevron={onPress ? "right" : undefined}
      onPress={onPress}
    />
  );
}
