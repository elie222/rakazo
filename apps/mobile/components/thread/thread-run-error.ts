import type { BillingStatus } from "@rakazo/contracts";
import { computerHoursOut } from "@rakazo/contracts";
import { canRetryRun } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import type { MobileSnapshot } from "../../lib/mobile-types";
import { openModelSettings } from "../../lib/model-settings";
import { computerHoursOutCopy, runErrorActionLabel } from "../../lib/run-error-presentation";
import { errorText } from "../../lib/user-error";
import { useRunError } from "../run-error-sheet";

/** The chat's failed run: its error, the recovery action, retry, and whether its details are open. */
export function useThreadRunError(
  run: MobileSnapshot["run"] | undefined,
  thread: {
    botId?: string;
    groupId?: string;
    userId: string;
    refresh: () => Promise<unknown>;
    isCurrentTarget: (botId?: string, groupId?: string) => boolean;
  },
) {
  const { botId } = thread;
  const { t } = useI18n();
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // A group keeps its failure on screen until a newer run ends, so a retried one hides here.
  const [retried, setRetried] = useState<{ runId: string; busy: boolean } | null>(null);
  const runError =
    run?.status === "failed" && !(retried?.runId === run.id && !retried.busy)
      ? (run.error ?? null)
      : null;
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
  const retry =
    runError && run && canRetryRun(run, thread.userId)
      ? {
          busy: retried?.runId === run.id,
          onPress: () => {
            const { groupId } = thread;
            if (retried?.runId === run.id || (!botId && !groupId)) return;
            setRetried({ runId: run.id, busy: true });
            rpc("threads/retry", { ...(groupId ? { groupId } : { botId: botId! }), runId: run.id })
              .then(async () => {
                setRetried({ runId: run.id, busy: false });
                if (thread.isCurrentTarget(botId, groupId)) await thread.refresh().catch(() => {});
              })
              .catch((error: unknown) => {
                setRetried(null);
                if (thread.isCurrentTarget(botId, groupId)) Alert.alert(errorText(error));
              });
          },
        }
      : null;
  return { runError, normalizedRunError, runErrorAction, retry, detailsOpen, setDetailsOpen };
}
