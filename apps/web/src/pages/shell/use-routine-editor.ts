import { useLingui } from "@lingui/react/macro";
import type { Bot, Routine, ThinkingLevel, ThreadSnapshot } from "@rakazo/contracts";
import { cronFromPreset } from "@rakazo/core";
import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import { parseModelOptionKey } from "../../lib/model-catalog";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { sharedInflight } from "../../lib/shared-inflight";
import { errorText } from "../../lib/user-error";
import type { RoutineDraftState, RoutineEditor } from "../RoutineEditor";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  routineNeedsOneShotArm,
  watchFromDraft,
} from "../RoutineEditor";

export function useRoutineEditor({
  rpc,
  active,
  activeBotId,
  timezone,
  setBots,
  refreshThread,
  setPanel,
  messageProviders,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  active: Bot | undefined;
  activeBotId: RefObject<string | undefined>;
  timezone: string | null | undefined;
  messageProviders: string[];
  setBots: Dispatch<SetStateAction<Bot[]>>;
  refreshThread: (botId: string) => Promise<ThreadSnapshot>;
  setPanel: (panel: Panel) => void;
}) {
  const { t } = useLingui();
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const routineSavePending = useRef(false);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setRoutineWebhookSecret(result.secret);
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);

  function restoreRoutine(routine: Routine | null) {
    setEditingRoutine(routine);
    setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
    setRoutineWebhookSecret(null);
  }
  function editRoutine(routine: Routine) {
    setRoutineDraft(draftFromRoutine(routine));
    setRoutineWebhookSecret(null);
    setEditingRoutine(routine);
  }
  function startRoutine(routine?: Routine) {
    setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
    setRoutineWebhookSecret(null);
    setEditingRoutine(routine ?? null);
    setRoutineError(null);
    setPanel("routine");
  }
  function resetRoutineTarget() {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
  }
  function leaveRoutine() {
    routineSaveRequest.current += 1;
    setRoutineError(null);
  }
  const editorProps = active
    ? ({
        draft: routineDraft,
        onChange: setRoutineDraft,
        editing: editingRoutine,
        timezone: editingRoutine?.timezone ?? timezone ?? localTimezone(),
        webhook: {
          path:
            typeof window !== "undefined"
              ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
              : `/api/v1/bots/${active.id}/webhook`,
          secret: routineWebhookSecret,
          configured: active.webhookConfigured || Boolean(routineWebhookSecret),
        },
        githubPath:
          typeof window !== "undefined"
            ? `${window.location.origin}/api/v1/bots/${active.id}/github`
            : `/api/v1/bots/${active.id}/github`,
        messageProviders,
        saving: savingRoutine,
        running: runningRoutine,
        error: routineError,
        onBack: () => setPanel("computer"),
        onClose: () => setPanel(null),
        onEnsureWebhook: async () => {
          await ensureWebhookSecret(active.id);
        },
        onSave: async () => {
          if (routineSavePending.current) return;
          const targetBotId = active.id;
          const targetRoutine = editingRoutine;
          if (targetRoutine && targetRoutine.botId !== targetBotId) return;
          if (
            !routineDraft.schedules.length &&
            !routineDraft.webhookEnabled &&
            !routineDraft.githubEnabled &&
            !routineDraft.messageProvider &&
            !routineDraft.watch
          ) {
            setRoutineError(t`Add a trigger to run this routine.`);
            return;
          }
          const watchResult = routineDraft.watch ? watchFromDraft(routineDraft.watch) : null;
          if (watchResult && "error" in watchResult) {
            setRoutineError(watchResult.error);
            return;
          }
          const watch = watchResult?.watch ?? null;
          const saveRequest = ++routineSaveRequest.current;
          routineSavePending.current = true;
          setSavingRoutine(true);
          setRoutineError(null);
          try {
            if (
              (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
              !active.webhookConfigured &&
              !routineWebhookSecret
            ) {
              await ensureWebhookSecret(targetBotId);
            }
            const crons = routineDraft.schedules.map(cronFromPreset);
            const model = routineDraft.modelKey ? parseModelOptionKey(routineDraft.modelKey) : null;
            const routineModel = {
              modelProvider: model?.provider ?? null,
              modelId: model?.modelId ?? null,
              thinkingLevel: (model && routineDraft.thinkingLevel
                ? routineDraft.thinkingLevel
                : null) as ThinkingLevel | null,
            };
            let saved: Routine;
            if (targetRoutine) {
              const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
              let runAt: string | undefined;
              if (armOneShot) {
                if (!routineDraft.runAtLocal) {
                  setRoutineError(t`Add a run time for this one-shot.`);
                  return;
                }
                const parsed = new Date(routineDraft.runAtLocal);
                if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                  setRoutineError(t`Run time must be in the future.`);
                  return;
                }
                runAt = parsed.toISOString();
              }
              saved = await rpc.routines.update({
                routineId: targetRoutine.id,
                name: routineDraft.name || t`Routine`,
                prompt: routineDraft.prompt || t`Check in.`,
                crons,
                active: armOneShot ? true : routineDraft.active,
                webhookEnabled: routineDraft.webhookEnabled,
                githubEnabled: routineDraft.githubEnabled,
                messageProvider: routineDraft.messageProvider,
                watch,
                ...(routineModel.modelProvider !== targetRoutine.modelProvider ||
                routineModel.modelId !== targetRoutine.modelId ||
                routineModel.thinkingLevel !== targetRoutine.thinkingLevel
                  ? routineModel
                  : {}),
                ...(runAt ? { runAt } : {}),
              });
            } else {
              saved = await rpc.routines.create({
                botId: targetBotId,
                name: routineDraft.name || t`Routine`,
                prompt: routineDraft.prompt || t`Check in.`,
                crons,
                timezone: timezone ?? localTimezone(),
                active: routineDraft.active,
                notify: true,
                webhookEnabled: routineDraft.webhookEnabled,
                githubEnabled: routineDraft.githubEnabled,
                messageProvider: routineDraft.messageProvider,
                watch,
                ...routineModel,
              });
            }
            if (routineSaveRequest.current === saveRequest && activeBotId.current === targetBotId) {
              setEditingRoutine(saved);
              // Fields edited while the save was in flight keep the newer value.
              const fresh = draftFromRoutine(saved);
              setRoutineDraft(
                (current) =>
                  Object.fromEntries(
                    Object.entries(fresh).map(([key, value]) => {
                      const field = key as keyof RoutineDraftState;
                      return [key, current[field] === routineDraft[field] ? value : current[field]];
                    }),
                  ) as RoutineDraftState,
              );
            }
          } catch (error) {
            if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
              return;
            }
            setRoutineError(errorText(error, t`Could not save routine`));
            return;
          } finally {
            routineSavePending.current = false;
            setSavingRoutine(false);
          }
          if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
            return;
          }
          await refreshThread(targetBotId).catch(() => undefined);
        },
        onTestRun: async () => {
          if (routineRunPending.current) return;
          const targetBotId = active.id;
          const targetRoutine = editingRoutine;
          if (!targetRoutine) return;
          routineRunPending.current = true;
          setRunningRoutine(true);
          setRoutineError(null);
          try {
            await rpc.routines.testRun({ routineId: targetRoutine.id });
            await refreshThread(targetBotId);
          } catch (error) {
            if (activeBotId.current === targetBotId) {
              setRoutineError(errorText(error, t`Could not run routine`));
            }
          } finally {
            routineRunPending.current = false;
            setRunningRoutine(false);
          }
        },
        onDelete: () => {
          if (editingRoutine) {
            setDeleteRoutineTarget(editingRoutine);
            return;
          }
          setPanel("computer");
        },
      } satisfies ComponentProps<typeof RoutineEditor>)
    : null;
  const deleteDialogProps = deleteRoutineTarget
    ? {
        item: deleteRoutineTarget,
        noun: "routine" as const,
        onCancel: () => setDeleteRoutineTarget(null),
        onConfirm: async () => {
          const target = deleteRoutineTarget;
          await rpc.routines.remove({ routineId: target.id });
          setDeleteRoutineTarget(null);
          setEditingRoutine((current) => (current?.id === target.id ? null : current));
          if (activeBotId.current !== target.botId) return;
          await refreshThread(target.botId);
          if (activeBotId.current === target.botId) setPanel("computer");
        },
      }
    : null;
  return {
    editorProps,
    deleteDialogProps,
    editingRoutine,
    restoreRoutine,
    editRoutine,
    startRoutine,
    resetRoutineTarget,
    leaveRoutine,
    addSkillRoutine,
  };
}
