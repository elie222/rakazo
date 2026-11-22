import type { ProcessEvent } from "@rakazo/adapter-kit";

/** How a command its caller cancelled ends: the shell's status for an interrupt. */
export function* abortedCommandEvents(): Generator<ProcessEvent> {
  yield { type: "stderr", data: "command aborted\n" };
  yield { type: "exit", code: 130 };
}

/**
 * How a command that ran past its timeout ends: the output it had written so far, then the
 * status `timeout(1)` reports.
 */
export function* timedOutCommandEvents(
  timeoutMs: number,
  partial: { stdout?: string; stderr?: string } = {},
): Generator<ProcessEvent> {
  if (partial.stdout) yield { type: "stdout", data: partial.stdout };
  if (partial.stderr) yield { type: "stderr", data: partial.stderr };
  yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
  yield { type: "exit", code: 124 };
}
