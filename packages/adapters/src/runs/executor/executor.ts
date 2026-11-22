import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import type { ThreadEvents } from "@rakazo/db";
import { retryWhileDatabaseUnavailable } from "@rakazo/db";
import { createBrowserProvider } from "../../browser/browser-provider-factory.js";
import { createMediaGenerationProvider } from "../../media/media-generation-factory.js";
import { createPaidServiceProvider } from "../../payments/paid-services-factory.js";
import { createWebProvider } from "../../web/web-provider-factory.js";
import { assembleRunTurn } from "../assembly/run-assembly.js";
import {
  notifyRoutineRetryAttemptsExhausted,
  retryRoutineRun,
  wakeRoutine,
} from "../assembly/run-routines.js";
import { holdRunForChat } from "../lifecycle/chat-wait.js";
import type { RunExecutorServices } from "../lifecycle/run-attempt.js";
import {
  claimRunAttempt,
  findContinuableRun,
  holdRun,
  releaseRunHold,
} from "../lifecycle/run-attempt.js";
import { retryRunSetup, runEndedForThisWorker } from "../lifecycle/run-lifecycle.js";
import { resolveConnectedRunModel, resolveRunModel } from "../turn/run-model.js";
import { runModelTurn } from "../turn/run-model-turn.js";
import type { ExecutorDeps } from "./executor-deps.js";

export function createRunExecutor(executorDeps: ExecutorDeps) {
  const contextStrategy = executorDeps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
  const web = executorDeps.web ?? createWebProvider();
  const mediaGeneration = executorDeps.mediaGeneration ?? createMediaGenerationProvider();
  const paidServices = executorDeps.paidServices ?? createPaidServiceProvider();
  const browser =
    executorDeps.browser ?? createBrowserProvider(undefined, { sandbox: executorDeps.sandbox });
  const resolveConnectedModel = resolveConnectedRunModel.bind(undefined, executorDeps);

  // Run-scoped connector state (installed MCP sessions) outlives one attempt
  // but not its run, so the session side owns the lifetime: the connector ends
  // it when this worker observes the run's end, and bounds the rest itself.
  const endRunConnectorState = (runId: string) => executorDeps.connector?.endRun?.(runId);
  // Every terminal outcome funnels through finalizeRun — completion, failure,
  // the tool-loop stop and pre-turn failures — but only the attempt that still
  // owns the run finalizes it. A fenced-out attempt must not end the run's
  // state while a newer attempt of this run still needs it; whether it may end
  // it depends on the run row, not on this attempt. A rejected finalizeRun left
  // the run unfinished, so its state survives the retry. The write is fenced by the
  // lease, so it waits out a database failover instead of losing the run's outcome.
  const events: ThreadEvents = {
    ...executorDeps.events,
    finalizeRun: async (input) => {
      const result = await retryWhileDatabaseUnavailable(
        () => executorDeps.events.finalizeRun(input),
        { source: "run finalize", signal: executorDeps.shutdownSignal },
      );
      if (result || (await runEndedForThisWorker(executorDeps.prisma, input))) {
        endRunConnectorState(input.runId);
      }
      return result;
    },
  };
  const baseDeps: ExecutorDeps = { ...executorDeps, events };
  const services: RunExecutorServices = {
    executorDeps,
    contextStrategy,
    web,
    mediaGeneration,
    paidServices,
    browser,
    resolveConnectedModel,
  };
  return {
    resolveConnectedModel,
    contextStrategy,
    resolveModel: resolveRunModel.bind(undefined, baseDeps),
    wakeRoutine: wakeRoutine.bind(undefined, baseDeps),
    notifyRoutineRetryAttemptsExhausted: notifyRoutineRetryAttemptsExhausted.bind(
      undefined,
      baseDeps,
    ),
    retryRoutineRun: retryRoutineRun.bind(undefined, baseDeps),

    async continueRun(runId: string, workerId: string, onRunStarted?: () => void) {
      const run = await findContinuableRun(baseDeps, endRunConnectorState, runId);
      if (!run) return;
      const claim = await claimRunAttempt(baseDeps, run, workerId);
      if (!claim) {
        await holdRunForChat(baseDeps, run);
        return;
      }
      const hold = holdRun(baseDeps, claim);
      try {
        // Durable run ownership and its heartbeat now carry recovery. Model,
        // integration and computer setup must not occupy a queue dispatch slot.
        onRunStarted?.();
        hold.dispatchHandedOff = Boolean(onRunStarted);
        if (hold.setupFailure) throw hold.setupFailure.error;
        const turn = await assembleRunTurn(services, hold);
        if (!turn) return;
        await runModelTurn(services, hold, turn);
      } catch (setupError) {
        await retryRunSetup(
          hold.deps,
          run,
          { id: hold.attempt.id, workerId, fence: hold.fence },
          {
            resumeCheckpoint: hold.takeover.resumeCheckpoint,
            heldForTakeover: hold.takeover.heldForTakeover,
            dispatchHandedOff: hold.dispatchHandedOff,
            leaseValid: hold.lease.valid,
            secrets: hold.secrets,
          },
          setupError,
        );
      } finally {
        await releaseRunHold(hold, endRunConnectorState);
      }
    },
  };
}
