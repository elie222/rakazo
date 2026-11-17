import type { RunExecutorServices, RunHold } from "../lifecycle/run-attempt.js";
import { mayOpenModelStream, requeueComputerRun } from "../lifecycle/run-lifecycle.js";
import { takeoverCheckpointOf } from "../turn/takeover-resume.js";
import {
  loadComputerInstructions,
  loadModelFallbacks,
  prepareRunComputer,
  resolveRunCapabilities,
  selectRunTools,
  startTurnModel,
} from "./run-assembly-capabilities.js";
import { buildTurnPrompt, createRunContext } from "./run-assembly-context.js";
import { loadTurnContext, readThreadHistory } from "./run-assembly-history.js";
import type { ConnectedRun } from "./run-assembly-records.js";
import { connectRun, loadRunRecords, loadSavedTurn } from "./run-assembly-records.js";

/** Undefined when setup ended the run or handed it back, so there is no turn to run. */
export async function assembleRunTurn(services: RunExecutorServices, hold: RunHold) {
  const saved = await loadSavedTurn(services, hold);
  const records = await loadRunRecords(services, hold, { saved });
  const connected = await connectRun(services, hold, { records });
  const thread = await readThreadHistory(hold, { records });
  const turnContext = await loadTurnContext(hold, { records, connected, thread });
  const model = await startTurnModel(hold, { saved, records });
  if (!model) return;
  const computer = await prepareRunComputer(hold, { records, connected, turnContext, model });
  const capabilities = await resolveRunCapabilities(services, hold, {
    saved,
    records,
    connected,
    thread,
    model,
    computer,
  });
  const tools = await selectRunTools(services, hold, {
    saved,
    records,
    connected,
    turnContext,
    capabilities,
  });
  const computerInstructions = await loadComputerInstructions(hold, {
    records,
    connected,
    computer,
    capabilities,
    tools,
  });
  const ctx = await createRunContext(services, hold, {
    saved,
    records,
    connected,
    turnContext,
    model,
    computer,
    capabilities,
    tools,
    computerInstructions,
  });
  const prompt = await buildTurnPrompt(hold, {
    saved,
    records,
    connected,
    thread,
    turnContext,
    model,
    computer,
    capabilities,
    tools,
    ctx,
  });
  if (!(await turnMayStillStart(hold, { connected }))) return;
  const fallbacks = await loadModelFallbacks(hold, { records, model, capabilities });
  return {
    saved,
    records,
    connected,
    thread,
    turnContext,
    model,
    computer,
    capabilities,
    tools,
    computerInstructions,
    ctx,
    prompt,
    fallbacks,
  };
}

export type AssembledTurn = NonNullable<Awaited<ReturnType<typeof assembleRunTurn>>>;

/** False when the run was released from a takeover, stopped or reclaimed while it was set up. */
async function turnMayStillStart(
  hold: RunHold,
  parts: { connected: ConnectedRun },
): Promise<boolean> {
  const { deps, runId, workerId, fence, lease } = hold;
  const { heldForTakeover } = hold.takeover;
  const { runAbortController } = parts.connected;
  if (heldForTakeover) {
    const releasedCheckpoint = takeoverCheckpointOf(
      (
        await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { checkpoint: true },
        })
      )?.checkpoint,
    );
    if (releasedCheckpoint) {
      await requeueComputerRun(deps, runId, workerId, fence, releasedCheckpoint, false);
      return false;
    }
  }

  // Stop during setup must not still open the model. A reclaimed lease can
  // leave status "running" under a new owner, and the stream loop only
  // notices cancellation after the provider request has started.
  const beforeModel = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { status: true, leaseOwner: true, leaseFence: true },
  });
  if (
    !mayOpenModelStream(
      beforeModel,
      workerId,
      fence,
      !lease.valid || Boolean(runAbortController?.signal.aborted),
    )
  ) {
    return false;
  }
  return true;
}
