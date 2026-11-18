import { useLingui } from "@lingui/react/macro";
import type { RoutineRun } from "@rakazo/contracts";
import { formatRoutineRunAt } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n/i18n";
import { activityStatusLabel, routineRunLateLabel } from "../../lib/inbox/activity";
import { native } from "../../lib/native/native";
import { routineRunDestination, useRoutineRuns } from "../../lib/routines/routine-runs";
import { RunErrorSheet, useRunError } from "../cards/run-error-sheet";
import { NativeActionButton } from "../native/native-action-button";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";

export function RoutineRunHistory({
  routineId,
  botName,
}: {
  routineId: string;
  botName: string | undefined;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const history = useRoutineRuns(routineId);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  if (!history.runs) {
    if (!history.failed) return <ActivityIndicator color={native.secondaryLabel} />;
    return (
      <>
        <SettingsGroup>
          <SettingsRow key="failed" title={t`Could not load run history`} dimmed />
        </SettingsGroup>
        <NativeActionButton
          label={t`Try again`}
          variant="text"
          prominence="secondary"
          onPress={history.retry}
        />
      </>
    );
  }
  return (
    <>
      <SettingsGroup>
        {history.runs.length === 0 ? (
          <SettingsRow key="empty" title={t`No runs yet`} dimmed />
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
          <SettingsRow key="failed" title={t`Could not load run history`} dimmed />
        ) : null}
      </SettingsGroup>
      {history.hasOlder ? (
        <NativeActionButton
          label={t`Load older runs`}
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
  const { t } = useLingui();
  const locale = useUiLocale();
  const failure = useRunError(error);
  const title = formatRoutineRunAt(run, dateLocaleForUi(locale));
  return (
    <SettingsRow
      accessibilityRole={onPress ? "button" : undefined}
      title={title}
      detail={failure?.summary ?? routineRunLateLabel(run)}
      value={
        run.status !== "completed"
          ? activityStatusLabel(run.status)
          : run.messageId
            ? undefined
            : t`No reply`
      }
      chevron={onPress ? "right" : undefined}
      onPress={onPress}
    />
  );
}
