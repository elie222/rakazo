import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import {
  type ToolHookCall,
  type ToolHookRunner,
  toolHookBlockedError,
  toolHookNoticeText,
} from "@rakazo/core";
import { normalizedHttpUrl } from "@rakazo/core/egress";

/**
 * The arguments a hook judges. web_fetch fetches the URL its gate normalizes, and parsing drops
 * tabs and newlines inside it, so a hook must see that URL and not the raw string the model wrote.
 */
export function hookArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "web_fetch" || typeof args.url !== "string") return args;
  const url = normalizedHttpUrl(args.url);
  return url ? { ...args, url } : args;
}

/**
 * A shell command that is still running when its call returns reports its final output later,
 * in a message of its own. That output is a tool result too, so it goes through the after-hooks
 * before the bot reads it: withheld on a deny, flagged on a warn.
 */
export function hookShellCompletions(
  observer: AgentToolExecutionObserver | undefined,
  hooks: ToolHookRunner,
  call: ToolHookCall,
): AgentToolExecutionObserver | undefined {
  const forward = observer?.onShellStillRunning;
  if (!observer || !forward) return observer;
  return {
    ...observer,
    onShellStillRunning: (completion) =>
      forward(
        completion.then(async (finished) => {
          const outcome = await hooks.after(
            { ...call, run: { ...call.run, tainted: true } },
            finished,
          );
          const denied = outcome.verdicts.find((verdict) => verdict.decision === "deny");
          if (denied)
            return {
              stdout: "",
              stderr: toolHookBlockedError(denied, "after").error,
              code: finished.code,
            };
          const warned = outcome.verdicts.find((verdict) => verdict.decision === "warn");
          return warned
            ? { ...finished, stderr: `${toolHookNoticeText(warned)}\n${finished.stderr}` }
            : finished;
        }),
      ),
  };
}
