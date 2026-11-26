import { computerHoursOut } from "@rakazo/contracts";
import { canRetryRun } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import type { MobileSnapshot } from "../../lib/api/mobile-types";
import { errorText } from "../../lib/api/user-error";
import { computerHoursOutCopy, runErrorActionLabel } from "../../lib/cards/run-error-presentation";
import { openModelSettings } from "../../lib/models/model-settings";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { useRunError } from "../cards/run-error-sheet";

/** The chat's failed run: its error, the recovery action, retry, and whether its details are open. */
export function useThreadRunError(
  run: MobileSnapshot["run"] | undefined,
  thread: {
    botId?: string;
    groupId?: string;
    userId: string;
    isCurrentTarget: (botId?: string, groupId?: string) => boolean;
  },
) {
  const { botId } = thread;
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Hide the old failure while the live retry signal refreshes the thread.
  const [retriedRunId, setRetriedRunId] = useState<string | null>(null);
  const runError = run?.status === "failed" && retriedRunId !== run.id ? (run.error ?? null) : null;
  const classified = useRunError(runError, false);
  const failedRunId = runError ? run?.id : null;
  const failedRunIdRef = useRef(failedRunId);
  failedRunIdRef.current = failedRunId;
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
  const retrySave = useSave({
    save: (input: { botId?: string; groupId?: string; runId: string }, send) =>
      send("threads/retry", {
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId! }),
        runId: input.runId,
      }),
    onSaved: (_, input) => setRetriedRunId(input.runId),
    onFailed: (error, input) => {
      if (
        thread.isCurrentTarget(input.botId, input.groupId) &&
        failedRunIdRef.current === input.runId
      ) {
        Alert.alert(errorText(error));
      }
    },
  });
  const { groupId } = thread;
  const retryingOther = retrySave.pending && retrySave.input?.runId !== run?.id;
  const retry =
    runError &&
    run &&
    !retryingOther &&
    !normalizedRunError?.recovery &&
    canRetryRun(run, thread.userId) &&
    (botId || groupId)
      ? {
          busy: retrySave.pending && retrySave.input?.runId === run.id,
          onPress: () => retrySave.run({ botId, groupId, runId: run.id }),
        }
      : null;
  return { runError, normalizedRunError, runErrorAction, retry, detailsOpen, setDetailsOpen };
}
