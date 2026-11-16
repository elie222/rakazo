import { bestEffort } from "@rakazo/logging";
import type { StatusLineWriter } from "./status-lines.js";

export type LiveStatusLines = {
  /**
   * Whether steps go to the status model: true while it is still being looked up, so an early
   * step waits for it, and false without one or once the run ended.
   */
  active(): boolean;
  /** A step the status model words for the person. Without an answer, its own line shows. */
  step(text: string): void;
  /** Something else now owns the working line: the model's own status, or its reply text. */
  supersede(): void;
  /** Shows the current step's status again, after something else cleared the line. */
  restore(): void;
  /** The turn ended: nothing more is shown and pending writes are cancelled. */
  close(): void;
};

export type StatusLineTarget = {
  /** The status model's writer; undefined when the member chose none. */
  writer: Promise<StatusLineWriter | undefined>;
  /** The person's message the run answers. */
  request: string;
  /**
   * Settles once the run's own credentials are registered for redaction. Nothing reaches the
   * status model before then. Without it, calls start at once.
   */
  ready?: Promise<unknown>;
  /** False when the attempt resumes earlier work: the moment for an opening status has passed. */
  opening?: boolean;
  /** The run's own abort: when it fires, every pending status request stops too. */
  signal?: AbortSignal;
  /** Shows one status as the working line. */
  show(text: string): Promise<unknown>;
  /** Whether the bot's own note holds the working line right now. */
  held(): boolean;
};

/**
 * Runs the member's status model alongside the run: one opening status about taking in the
 * request shows as soon as it is ready, while the run sets up and the main model thinks, and
 * each step it starts without a status of its own gets one. A status shows only while nothing
 * newer took over, and statuses are shown one at a time, in order.
 */
export function startStatusLines(target: StatusLineTarget): LiveStatusLines {
  const abort = new AbortController();
  const onRunAbort = () => close();
  let generation = 0;
  // The generation a supersede last ended; a later one with nothing new to end does nothing.
  let supersededAt = -1;
  let closed = false;
  let hasWriter = false;
  let writerKnown = false;
  // The last status shown, and the step it belongs to.
  let lastShown: { text: string; generation: number } | undefined;
  // The request for whatever the line shows now; a newer step or status cancels it.
  let current = new AbortController();
  const replaceCurrent = () => {
    current.abort();
    current = new AbortController();
    return AbortSignal.any([abort.signal, current.signal]);
  };
  // Each status waits for the one before it, so a slow write never lands after a newer one.
  let showing: Promise<unknown> = Promise.resolve();
  const show = (text: string, mine: number) => {
    showing = showing.then(async () => {
      if (closed || mine !== generation || target.held()) return;
      await bestEffort("show status line", target.show(text));
      lastShown = { text, generation: mine };
    });
    return showing;
  };

  // The writer, once the run's credentials are known; nothing is sent to the model before.
  const writer = Promise.all([target.writer, target.ready]).then(([found]) => found);
  void bestEffort("set up status model", target.writer).then((found) => {
    hasWriter = Boolean(found);
    writerKnown = true;
  });
  function close() {
    closed = true;
    abort.abort();
    target.signal?.removeEventListener("abort", onRunAbort);
  }
  if (target.signal?.aborted) close();
  else target.signal?.addEventListener("abort", onRunAbort, { once: true });

  const opening = ++generation;
  void bestEffort(
    "write opening status",
    writer.then(async (writer) => {
      // A step or reply that came first owns the line: the opening is never requested.
      if (!writer || closed || opening !== generation || target.opening === false) return;
      const line = await writer.opening(
        target.request,
        AbortSignal.any([abort.signal, current.signal]),
      );
      if (line) await show(line, opening);
    }),
  );

  return {
    active: () => !closed && (hasWriter || !writerKnown),
    step(text) {
      const mine = ++generation;
      const signal = replaceCurrent();
      void bestEffort(
        "write step status",
        writer.then((writer) => writer?.step(target.request, text, signal)),
      ).then((line) => {
        return show(line || text, mine);
      });
    },
    supersede() {
      // Every streamed text delta supersedes; only the first after a status has work to do.
      if (supersededAt === generation) return;
      generation += 1;
      supersededAt = generation;
      replaceCurrent();
    },
    restore() {
      if (lastShown && lastShown.generation === generation) void show(lastShown.text, generation);
    },
    close,
  };
}
