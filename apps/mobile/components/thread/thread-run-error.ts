import { computerHoursOut } from "@rakazo/contracts";
import { canRetryRun } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { rpc } from "../../lib/api/api";
import type { MobileSnapshot } from "../../lib/api/mobile-types";
import { errorText } from "../../lib/api/user-error";
import { computerHoursOutCopy, runErrorActionLabel } from "../../lib/cards/run-error-presentation";
import { openModelSettings } from "../../lib/models/model-settings";
import { queryClient, rpcQuery } from "../../lib/query/query";
import { useRunError } from "../cards/run-error-sheet";

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
  const asksBilling = needsPlan && Boolean(failedRunId);
  const billingQuery = useQuery(
    { ...rpcQuery("billing/status"), enabled: asksBilling },
    queryClient,
  );
  const { refetch } = billingQuery;
  // Each failed run reads the plan again, since it may have changed since the last one.
  useEffect(() => {
    if (asksBilling) void refetch({ cancelRefetch: false });
  }, [asksBilling, failedRunId, refetch]);
  const billing = billingQuery.data ?? null;
  const hoursOut = needsPlan && billing ? computerHoursOutCopy(computerHoursOut(billing)) : null;
  const normalizedRunError =
    classified && hoursOut ? { ...classified, summary: hoursOut.summary } : classified;
  const label = needsPlan
    ? billing?.canManage
      ? (hoursOut?.action ?? null)
      : null
    : normalizedRunError
      ? runErrorActionLabel(normalizedRunError)
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
