import type { BillingStatus } from "@rakazo/contracts";
import { computerHoursOut } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import type { MobileSnapshot } from "../../lib/mobile-types";
import { openModelSettings } from "../../lib/model-settings";
import { computerHoursOutCopy, runErrorActionLabel } from "../../lib/run-error-presentation";
import { useRunError } from "../run-error-sheet";

/** The chat's failed run: its error, the recovery action, and whether its details are open. */
export function useThreadRunError(run: MobileSnapshot["run"] | undefined, botId?: string) {
  const { t } = useI18n();
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const runError = run?.status === "failed" ? (run.error ?? null) : null;
  const classified = useRunError(runError, false);
  const failedRunId = runError ? run?.id : null;
  useEffect(() => setDetailsOpen(false), [failedRunId]);
  const needsPlan = classified?.recovery === "plan";
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  useEffect(() => {
    if (!needsPlan || !failedRunId) return;
    let active = true;
    void rpc("billing/status")
      .then((status) => {
        if (active) setBilling(status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [needsPlan, failedRunId]);
  const hoursOut = needsPlan && billing ? computerHoursOutCopy(t, computerHoursOut(billing)) : null;
  const normalizedRunError =
    classified && hoursOut ? { ...classified, summary: hoursOut.summary } : classified;
  const label = needsPlan
    ? billing?.canManage
      ? (hoursOut?.action ?? null)
      : null
    : normalizedRunError
      ? runErrorActionLabel(t, normalizedRunError)
      : null;
  const runBotId = run?.botId ?? botId;
  const runErrorAction = label
    ? {
        label,
        onPress: () => {
          setDetailsOpen(false);
          if (needsPlan) router.push("/billing");
          else if (normalizedRunError?.recovery === "model" && runBotId)
            router.push({ pathname: "/bot-settings", params: { botId: runBotId, focus: "model" } });
          // Without a bot to change, the model settings pick the default model instead.
          else openModelSettings();
        },
      }
    : null;
  return { runError, normalizedRunError, runErrorAction, detailsOpen, setDetailsOpen };
}
