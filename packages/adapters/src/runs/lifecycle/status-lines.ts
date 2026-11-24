import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { modelRoleConnectionId } from "@rakazo/contracts";
import { deadlineSignal, redactSecrets, withAbort } from "@rakazo/core";
import { recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { effectiveModelRole } from "../../models/model-roles.js";
import { isRuntimeFailureText } from "../../runtime/runtime-failure-text.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveConnectedModelKey, resolvedModelRunFields } from "../turn/run-model.js";
import {
  openingStatusPrompt,
  STATUS_LINE_INSTRUCTIONS,
  stepStatusPrompt,
} from "./status-lines.prompt.js";
import { narrationStatusLine } from "./user-progress.js";

/** How long a status line may take before the working line moves on without it. */
const STATUS_LINE_TIMEOUT_MS = 15_000;
export type StatusLineScope = {
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
};

/** Writes short status lines with the member's status model, when they chose one. */
export interface StatusLineWriter {
  /**
   * One status for the moment before the first step, about taking in the request: nothing has
   * been done yet, so it never claims work.
   */
  opening(request: string, signal: AbortSignal): Promise<string | undefined>;
  /** One status for a step, from its technical description. */
  step(request: string, step: string, signal: AbortSignal): Promise<string | undefined>;
}

/**
 * The status-line writer for this run, or undefined when the member chose no status model.
 * Any failure to set it up leaves the run on the statuses its own model writes.
 */
export async function createStatusLineWriter(
  deps: ExecutorDeps,
  scope: StatusLineScope,
  secrets: string[],
): Promise<StatusLineWriter | undefined> {
  try {
    const { primary, backups } = await effectiveModelRole(
      deps.prisma,
      { userId: scope.userId, spaceId: scope.spaceId },
      "status",
      {},
    );
    // The primary first, then each fallback in order; a model's key is resolved once, when
    // it is first needed. A member may have saved only fallbacks: the deployment fills no
    // primary for this role.
    const choices = primary ? [primary, ...backups] : [...backups];
    if (!choices.length) return undefined;
    const keys = new Map<
      ModelRoleChoice,
      Promise<Awaited<ReturnType<typeof resolveConnectedModelKey>>["resolved"]>
    >();
    const keyFor = (choice: ModelRoleChoice) => {
      let key = keys.get(choice);
      if (!key) {
        // The same checks as any other role model: an allowed provider, a valid choice, and
        // a pinned connection that still exists. A missing one fails over to the next model
        // instead of running on the deployment's key.
        key = resolveConnectedModelKey(
          deps,
          { userId: scope.userId, spaceId: scope.spaceId },
          choice.provider,
          choice.modelId,
          (values) => secrets.push(...values),
          true,
          modelRoleConnectionId(choice),
        ).then(({ resolved }) => resolved);
        keys.set(choice, key);
        // A failed lookup is not kept: the next status tries the model again.
        key.catch(() => {
          if (keys.get(choice) === key) keys.delete(choice);
        });
      }
      return key;
    };
    const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
      recordUsage(deps.prisma, event, {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        parentRunId: scope.runId,
        runId: scope.runId,
        operationId: `status-line:${scope.runId}`,
        operationKind: "setup",
      });
    // Each request runs under its own id, so concurrent ones share no runtime state.
    let requests = 0;
    const writeWith = async (
      choice: ModelRoleChoice,
      buildPrompt: () => string,
      signal: AbortSignal,
    ): Promise<string> => {
      // The time limit covers resolving the model's key as well as the call.
      const deadline = deadlineSignal(STATUS_LINE_TIMEOUT_MS, signal);
      const lookup = keyFor(choice);
      const key = await withAbort(lookup, deadline).catch((error: unknown) => {
        // A lookup that outlasted the time limit is not kept either: the next status starts a
        // new one rather than waiting on it again.
        if (!signal.aborted && keys.get(choice) === lookup) keys.delete(choice);
        throw error;
      });
      // Built only now, so it is redacted against the credentials just resolved too.
      const prompt = buildPrompt();
      const startedAt = Date.now();
      const runId = `${scope.runId}:status-line:${++requests}`;
      let text = "";
      let problem = "";
      // A provider that does not stop when aborted must not hold up the next model.
      const consume = (async () => {
        for await (const event of deps.runtime.run(
          {
            botId: scope.botId,
            threadId: scope.threadId,
            runId,
            usageOperationKind: "setup",
            // An empty answer stays empty, so the next model is tried instead of a placeholder.
            allowSilentEmpty: true,
            onUsage: async (event) => {
              await onUsage(event);
            },
            prompt,
            instructions: STATUS_LINE_INSTRUCTIONS,
            history: [],
            tools: [],
            model: {
              // Every field the connection carries, as any run gets it: no-retention routing,
              // project, region and protocol included.
              ...resolvedModelRunFields(key),
              provider: choice.provider,
              id: choice.modelId,
              // A status line needs no extended thinking; it only adds delay.
              thinkingLevel: choice.thinkingLevel ?? "off",
              // Credit charges belong to the run, not to this request's own id.
              callObserver: key.callObserver && {
                ...key.callObserver,
                beforeCall: (call) => key.callObserver!.beforeCall({ ...call, runId: scope.runId }),
              },
            },
          },
          {
            operationId: `status-line:${scope.runId}`,
            traceId: `status-line:${scope.runId}`,
            spaceId: scope.spaceId,
            userId: scope.userId,
            signal: deadline,
          },
        )) {
          if (event.type === "usage" && !event.accounted) await onUsage(event);
          if (event.type === "text" && isRuntimeFailureText(event.text))
            problem = event.text.trim();
          if (event.type === "done" && event.text) {
            if (isRuntimeFailureText(event.text)) problem = event.text.trim();
            else text = event.text;
          }
        }
      })();
      await withAbort(consume, deadline);
      if (problem || !text.trim()) {
        getLogger().warn("status_line.empty", {
          "model.provider": choice.provider,
          "model.id": choice.modelId,
          duration_ms: Date.now() - startedAt,
          ...(problem ? { problem: redactSecrets(problem, secrets).slice(0, 200) } : {}),
        });
      }
      return problem ? "" : text;
    };
    const quietly = (choice: ModelRoleChoice) => (error: unknown) => {
      if (isCancelled(error)) return "";
      getLogger().warn("status_line.failed", {
        "model.provider": choice.provider,
        "model.id": choice.modelId,
        error: redactedError(error, secrets),
      });
      return "";
    };
    /**
     * The statuses from the first model whose answer has any; a cancelled turn stops trying.
     */
    const write = async (buildPrompt: () => string, signal: AbortSignal) => {
      for (const choice of choices) {
        if (signal.aborted) return [];
        const text = await writeWith(choice, buildPrompt, signal).catch(quietly(choice));
        const lines = statusLinesFrom(text, secrets);
        if (lines.length) return lines;
      }
      return [];
    };
    return {
      async opening(request, signal) {
        const lines = await write(
          () => openingStatusPrompt(redactSecrets(request, secrets)),
          signal,
        );
        return lines[0];
      },
      async step(request, step, signal) {
        const lines = await write(
          () => stepStatusPrompt(redactSecrets(request, secrets), redactSecrets(step, secrets)),
          signal,
        );
        return lines[0];
      },
    };
  } catch (error) {
    getLogger().warn("status_line.setup_failed", { error: redactedError(error, secrets) });
    return undefined;
  }
}

/** An error's name and message with the run's secrets removed: a provider can echo a key. */
function redactedError(error: unknown, secrets: string[]) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(text, secrets).slice(0, 200);
}

/**
 * A turn that ended or moved on cancels its pending status; that is no failure. A timeout is
 * one, so it is logged.
 */
function isCancelled(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/** The status lines in a reply, cleaned: list marks, quotes and a final period removed. */
export function statusLinesFrom(text: string, secrets: string[] = []): string[] {
  return redactSecrets(text, secrets)
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .replace(/^["“'`]+|["”'`]+$/g, "")
        .replace(/[.。]+$/, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && line.length <= 80 && !/^</.test(line))
    .map(narrationStatusLine);
}
