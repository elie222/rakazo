import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { recordUsage } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { effectiveModelRole } from "./model-roles.js";
import { findConnectedModelCredential } from "./model-selection.js";
import { resolveModelKey } from "./run-model.js";
import { narrationStatusLine } from "./user-progress.js";

/** How long a status line may take before the working line moves on without it. */
const STATUS_LINE_TIMEOUT_MS = 15_000;
/** The person's message is cut to this length before it reaches the status model. */
const MAX_REQUEST_CHARS = 1_200;
/** A tool's technical description is cut to this length. */
const MAX_STEP_CHARS = 300;

const STATUS_LINE_INSTRUCTIONS = [
  "You write the live status line a chat assistant shows while it works on the person's request.",
  "Write in the language of the person's message inside <request>, whatever language these instructions or the examples use.",
  "Each status is two to five words, in the present continuous (for example “Checking availability”), says what is being done for the person, never technical details, file paths or commands.",
  "No final period, no quotes, no emoji, no markdown. Output only the status lines.",
].join(" ");

export type StatusLineScope = {
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
};

/** Writes short status lines with the member's status model, when they chose one. */
export interface StatusLineWriter {
  /** A few statuses for the first moments of work on the request, in the order to show. */
  opening(request: string, signal: AbortSignal): Promise<string[]>;
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
    if (!primary) return undefined;
    // The primary first, then each fallback in order; a model's key is resolved once, when
    // it is first needed.
    const choices = [primary, ...backups];
    const keys = new Map<ModelRoleChoice, ReturnType<typeof resolveModelKey>>();
    const keyFor = (choice: ModelRoleChoice) => {
      let key = keys.get(choice);
      if (!key) {
        key = findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          { userId: scope.userId, spaceId: scope.spaceId },
          choice.provider,
          choice.modelId,
          { credentialId: choice.credentialId },
        ).then((credential) =>
          resolveModelKey(
            deps,
            scope.userId,
            scope.spaceId,
            credential,
            choice.provider,
            choice.modelId,
            (values) => secrets.push(...values),
          ),
        );
        keys.set(choice, key);
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
    const writeWith = async (
      choice: ModelRoleChoice,
      buildPrompt: () => string,
      signal: AbortSignal,
    ): Promise<string> => {
      // The time limit covers resolving the model's key as well as the call.
      const timeout = AbortSignal.timeout(STATUS_LINE_TIMEOUT_MS);
      const deadline = AbortSignal.any([signal, timeout]);
      const key = await untilAborted(keyFor(choice), deadline);
      // Built only now, so it is redacted against the credentials just resolved too.
      const prompt = buildPrompt();
      const startedAt = Date.now();
      let text = "";
      let problem = "";
      // A provider that does not stop when aborted must not hold up the next model.
      const consume = (async () => {
        for await (const event of deps.runtime.run(
          {
            botId: scope.botId,
            threadId: scope.threadId,
            runId: `${scope.runId}:status-line`,
            usageOperationKind: "setup",
            onUsage: async (event) => {
              await onUsage(event);
            },
            prompt,
            instructions: STATUS_LINE_INSTRUCTIONS,
            history: [],
            tools: [],
            model: {
              provider: choice.provider,
              id: choice.modelId,
              apiKey: key.oauth ? undefined : key.apiKey,
              accountId: key.accountId,
              gatewayId: key.gatewayId,
              baseUrl: key.baseUrl,
              headers: key.headers,
              allowPrivateEndpoint: key.allowPrivateEndpoint,
              cacheCapabilities: key.cacheCapabilities,
              contextWindow: key.contextWindow,
              maxTokens: key.maxTokens,
              reasoning: key.reasoning,
              // A status line needs no extended thinking; it only adds delay.
              thinkingLevel: choice.thinkingLevel ?? "off",
              oauth: key.oauth
                ? {
                    credential: key.oauth,
                    persist: key.persistOAuth,
                    refresh: key.refreshOAuth,
                    retire: key.retireOAuth,
                  }
                : undefined,
              callObserver: key.callObserver,
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
          if (event.type === "text" && isModelFailureText(event.text)) problem = event.text.trim();
          if (event.type === "done" && event.text) {
            if (isModelFailureText(event.text)) problem = event.text.trim();
            else text = event.text;
          }
        }
      })();
      await untilAborted(consume, deadline);
      if (problem || !text.trim()) {
        // biome-ignore lint/suspicious/noConsole: One sanitized status-line diagnostic.
        console.warn(
          `[status-line] ${choice.provider}/${choice.modelId} wrote nothing after ${Date.now() - startedAt}ms${problem ? `: ${redactSecrets(problem, secrets).slice(0, 200)}` : ""}`,
        );
      }
      return problem ? "" : text;
    };
    const quietly = (choice: ModelRoleChoice) => (error: unknown) => {
      if (isCancelled(error)) return "";
      // biome-ignore lint/suspicious/noConsole: One sanitized status-line diagnostic.
      console.warn(
        `[status-line] ${choice.provider}/${choice.modelId} failed: ${redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error), secrets).slice(0, 200)}`,
      );
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
          () =>
            `${requestPrompt(request, secrets)}\n\nWrite three different statuses for the first moments of working on this request, one per line, from first to last.`,
          signal,
        );
        return lines.slice(0, 3);
      },
      async step(request, step, signal) {
        const lines = await write(
          () =>
            `${requestPrompt(request, secrets)}\n\n<step>\n${clip(redactSecrets(step, secrets), MAX_STEP_CHARS)}\n</step>\n\nWrite one status for this step.`,
          signal,
        );
        return lines[0];
      },
    };
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: One sanitized status-line diagnostic.
    console.warn(
      `[status-line] could not set up the status model: ${redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 200)}`,
    );
    return undefined;
  }
}

/** Text a runtime writes in place of an answer when the model call failed. */
function isModelFailureText(text: string) {
  return /^(?:I hit a problem:|Unknown model )/i.test(text.trim());
}

/** The value, unless the signal aborts first. */
function untilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A turn that ended or moved on cancels its pending status; that is no failure. */
function isCancelled(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
    ? error.name === "AbortError"
    : false;
}

function requestPrompt(request: string, secrets: string[]) {
  return `<request>\n${clip(redactSecrets(request, secrets), MAX_REQUEST_CHARS)}\n</request>`;
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
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
