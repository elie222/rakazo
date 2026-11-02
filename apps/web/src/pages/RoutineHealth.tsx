import { Trans, useLingui } from "@lingui/react/macro";
import { Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { statusLabel } from "./ActivityList";

export function RoutineHealth({ routineId }: { routineId: string }) {
  const { i18n, t } = useLingui();
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const fieldId = useId();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const health = useQuery({
    ...queries.routines.health.queryOptions({ input: { routineId } }),
    refetchInterval: 15_000,
  });
  if (health.isError)
    return (
      <p role="alert">
        <Trans>Could not load schedule status</Trans>
      </p>
    );
  if (!health.data) return null;
  const date = (value: string) => new Date(value).toLocaleString(i18n.locale || "en");
  const { nextRunAt, delayed, lastAttempt, lastSuccessAt } = health.data;
  async function setAlert(field: "delayed" | "failure", enabled: boolean) {
    setSaving(true);
    setSaveError(false);
    try {
      await rpc.routines.setAlerts({ routineId, [field]: enabled });
      await health.refetch();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="mt-6 space-y-1 text-sm text-muted-foreground" data-testid="routine-health">
      {nextRunAt ? (
        <p>
          <Trans>Next scheduled</Trans>: {date(nextRunAt)}
        </p>
      ) : (
        <p>
          <Trans>No upcoming schedule</Trans>
        </p>
      )}
      {delayed ? (
        <p className="text-destructive">
          <Trans>Schedule delayed</Trans>
        </p>
      ) : null}
      {lastAttempt ? (
        <p>
          <Trans>Last attempt</Trans>: {date(lastAttempt.at)} · {statusLabel(lastAttempt.status)}
        </p>
      ) : null}
      {lastSuccessAt ? (
        <p>
          <Trans>Last successful run</Trans>: {date(lastSuccessAt)}
        </p>
      ) : (
        <p>
          <Trans>No successful runs yet</Trans>
        </p>
      )}
      <label htmlFor={`${fieldId}-delay`} className="flex items-center gap-2">
        <Switch
          id={`${fieldId}-delay`}
          aria-label={t`Delay alerts`}
          checked={health.data.delayAlertsEnabled}
          disabled={saving}
          onCheckedChange={(value) => void setAlert("delayed", value)}
        />
        <Trans>Delay alerts</Trans>
      </label>
      {health.data.delayAlertsEnabled ? (
        <p>
          <Trans>Delay alerts run while the worker is running.</Trans>
        </p>
      ) : null}
      <label htmlFor={`${fieldId}-failure`} className="flex items-center gap-2">
        <Switch
          id={`${fieldId}-failure`}
          aria-label={t`Failure alerts`}
          checked={health.data.failureAlertsEnabled}
          disabled={saving}
          onCheckedChange={(value) => void setAlert("failure", value)}
        />
        <Trans>Failure alerts</Trans>
      </label>
      {health.data.delayAlertResult === "failed" && delayed ? (
        <p className="text-destructive">
          <Trans>Alert could not be sent</Trans>
        </p>
      ) : null}
      {health.data.delayAlertResult === "sent" && delayed ? (
        <p>
          <Trans>Alert accepted; delivery not confirmed</Trans>
        </p>
      ) : null}
      {saveError ? (
        <p role="alert">
          <Trans>Could not save</Trans>
        </p>
      ) : null}
    </section>
  );
}
