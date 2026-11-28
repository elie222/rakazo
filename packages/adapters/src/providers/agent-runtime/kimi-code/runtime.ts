import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import { createTextTurn } from "./acp-text.js";

/** A fresh, disposable process boundary. A real launcher must own the process tree,
 * cap line size before buffering, and free the isolated home on close/abort.
 * The ACP client is not itself a process or workspace sandbox.
 */
interface ACPProviderBinding {
  readonly runId: string;
  readonly connectionId: string;
  readonly modelId: string;
}

interface IsolatedAcpChild {
  readonly cwd: string;
  readonly lines: AsyncIterable<string>;
  send(frame: object): Promise<void>;
  /**
   * Consume the per-child, one-use verdict from trusted provider egress, not ACP.
   * It may be returned only after the full response is verified successful for a
   * single exact upstream attempt. Missing, partial, retried, or failed responses
   * must not produce a verdict. This does not implement the egress observer.
   */
  consumeVerifiedProviderCompletion(): ACPProviderBinding | undefined;
  close(): void;
}

interface KimiRuntimeOptions {
  /** Server-side, run-scoped owner/DM, human invocation, and eligible credential check. */
  admitsInteractiveOwnerTurn(request: AgentRunRequest, context?: Partial<AdapterContext>): boolean;
  /** Operator-owned launcher boundary; no process or HTTP fallback exists here. */
  open(input: ACPProviderBinding & { apiKey: string; signal: AbortSignal }): IsolatedAcpChild;
}

/** Unregistered until launcher isolation and provider eligibility are verified.
 * Session IDs, reasoning and credentials never become runtime events.
 */
export function createKimiCodeRuntime(options: KimiRuntimeOptions): AgentRuntime {
  const active = new Map<string, AbortController>();
  return {
    describe: () => ({
      id: "kimi-code",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: false, compaction: false, tools: false, scripted: false },
    }),
    async *run(request, context): AsyncIterable<AgentRuntimeEvent> {
      const { model, runId } = request;
      if (
        active.has(runId) ||
        !model.connectionId ||
        !model.apiKey?.trim() ||
        model.oauth ||
        model.callObserver ||
        model.baseUrl ||
        model.headers ||
        request.routineId != null ||
        !request.sourceMessageId ||
        request.tools.length ||
        request.currentTurnImages?.length ||
        request.currentRunRequiresImageInput ||
        request.currentTurnImageFileFallback ||
        request.history.some(
          (item) =>
            item.speaker ||
            item.images?.length ||
            item.segments?.some((segment) => "steps" in segment),
        ) ||
        request.resumeFromCheckpoint ||
        request.turnCheckpoint ||
        request.resumeToolResult ||
        request.script ||
        request.computerModel ||
        request.fallbackModels?.length ||
        !options.admitsInteractiveOwnerTurn(request, context)
      ) {
        throw new Error("Kimi Code requires an eligible personal, interactive text-only turn.");
      }
      const controller = new AbortController();
      const parent = context?.signal
        ? AbortSignal.any([controller.signal, context.signal])
        : controller.signal;
      const signal = deadlineSignal(90_000, parent);
      active.set(runId, controller);
      let close: (() => void) | undefined;
      let result: string | undefined;
      try {
        signal.throwIfAborted();
        let closed = false;
        const binding = { runId, connectionId: model.connectionId, modelId: model.id };
        const child = options.open({ ...binding, apiKey: model.apiKey, signal });
        close = () => {
          if (closed) return;
          closed = true;
          child.close();
        };
        signal.addEventListener("abort", close, { once: true });
        signal.throwIfAborted();
        // Use one ephemeral native session; conversation replay is plain text only.
        const prompt = JSON.stringify({
          instructions: request.instructions,
          history: request.history.map(({ role, content }) => ({ role, content })),
          prompt: request.prompt,
        });
        const turn = createTextTurn({ cwd: child.cwd, prompt });
        await child.send(turn.initialize);
        const output: string[] = [];
        let frames = 0;
        for await (const line of child.lines) {
          signal.throwIfAborted();
          if (++frames > 2048) throw new Error("ACP frame limit exceeded.");
          const action = turn.receive(line);
          if (action.send) await child.send(action.send);
          if (action.denied) throw new Error("ACP tools are not offered.");
          if (action.text) output.push(action.text);
          if (action.done) {
            signal.throwIfAborted();
            // A CLI end_turn can also indicate a failed provider call.
            const receipt = child.consumeVerifiedProviderCompletion();
            if (
              receipt?.runId !== binding.runId ||
              receipt.connectionId !== binding.connectionId ||
              receipt.modelId !== binding.modelId
            )
              throw new Error("ACP provider completion could not be verified.");
            result = output.join("");
            break;
          }
        }
        if (
          !result ||
          [model.apiKey, ...(request.secrets ?? [])].some(
            (secret) => secret && result?.includes(secret),
          )
        )
          throw new Error("ACP response did not finish.");
      } catch {
        // Never expose child diagnostics, which can carry credentials or prompts.
        throw new Error("Kimi Code ACP turn did not complete.");
      } finally {
        active.delete(runId);
        if (close) {
          signal.removeEventListener("abort", close);
          close();
        }
      }
      signal.throwIfAborted();
      yield { type: "text", text: result };
      yield { type: "done", text: result };
    },
    async abort(runId) {
      active.get(runId)?.abort();
    },
  };
}
