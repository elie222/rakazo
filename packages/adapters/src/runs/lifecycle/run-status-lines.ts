import { deadlineSignal, withAbort } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";

/** How long showing one status may take before later ones go ahead without it. */
const SHOW_TIMEOUT_MS = 5_000;

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
  /**
   * The turn ended: nothing more is shown and pending requests are cancelled. Settles once the
   * status writes already under way have landed, or after a time limit, so none lands after
   * the run's end.
   */
  close(): Promise<void>;
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
};

/**
 * Runs the member's status model alongside the run: one opening status about taking in the
 * request shows as soon as it is ready, while the run sets up and the main model thinks, and
 * each step it starts without a status of its own gets one. A status shows only while nothing
 * newer took over, and statuses are shown one at a time, in order.
 */
export function startStatusLines(target: StatusLineTarget): LiveStatusLines {
  const abort = new AbortController();
  const onRunAbort = () => void close();
  let generation = 0;
  // The generation a supersede last ended; a later one with nothing new to end does nothing.
  let supersededAt = -1;
  let closed = false;
  let hasWriter = false;
  let writerKnown = false;
  // The last status shown, and the step it belongs to.
  let lastShown: { text: string; generation: number } | undefined;
  const scoped = (controller: AbortController) =>
    AbortSignal.any([abort.signal, controller.signal]);
  const opening = new AbortController();
  // Step requests still running. Steps often finish faster than the status model answers, so
  // the one before the newest keeps going: its status still says what the bot is doing, close
  // enough, rather than leaving the line as it was. Older ones are cancelled.
  const steps: AbortController[] = [];
  const cancelSteps = (keep: number) => {
    while (steps.length > keep) steps.shift()?.abort();
  };
  // Status writes under way, which the run's end waits for.
  const writes = new Set<Promise<boolean>>();
  // Each status waits for the one before it, so a slow write never lands after a newer one.
  let showing: Promise<unknown> = Promise.resolve();
  /**
   * Shows a status for step `mine`. `latestOnly` text shows only while its step is the newest;
   * a status model's answer shows while nothing newer was shown or took the line, and `again`
   * shows the status already on the line once more.
   */
  const show = (text: string, mine: number, { latestOnly = false, again = false } = {}) => {
    showing = showing.then(async () => {
      if (closed || mine <= supersededAt) return;
      const shownAt = lastShown?.generation ?? 0;
      if (latestOnly ? mine !== generation : again ? mine < shownAt : mine <= shownAt) return;
      const write = target.show(text).then(() => true);
      writes.add(write);
      void write.then(
        () => writes.delete(write),
        () => writes.delete(write),
      );
      // A stuck write must not hold back every later status.
      const shown = await bestEffort(
        "show status line",
        withAbort(write, deadlineSignal(SHOW_TIMEOUT_MS)),
      );
      if (shown) {
        lastShown = { text, generation: mine };
        return;
      }
      // A write that finishes after the queue moved on may land over a newer status: the newer
      // one then shows again, so the line never goes back.
      void bestEffort("show late status line", write).then((landed) => {
        if (!landed) return;
        const latest = lastShown;
        if (!latest || latest.generation < mine) lastShown = { text, generation: mine };
        else void show(latest.text, latest.generation, { again: true });
      });
    });
    return showing;
  };

  // The writer, once the run's credentials are known; nothing is sent to the model before.
  const writer = Promise.all([target.writer, target.ready]).then(([found]) => found);
  void bestEffort("set up status model", target.writer).then((found) => {
    hasWriter = Boolean(found);
    writerKnown = true;
  });
  async function close() {
    closed = true;
    abort.abort();
    target.signal?.removeEventListener("abort", onRunAbort);
    await bestEffort(
      "finish status line writes",
      withAbort(
        Promise.allSettled([showing, ...writes]).then(() => undefined),
        deadlineSignal(SHOW_TIMEOUT_MS),
      ),
    );
  }
  if (target.signal?.aborted) void close();
  else target.signal?.addEventListener("abort", onRunAbort, { once: true });

  const openingGeneration = ++generation;
  void bestEffort(
    "write opening status",
    writer.then(async (writer) => {
      // A step or reply that came first owns the line: the opening is never requested.
      if (!writer || closed || openingGeneration !== generation || target.opening === false) return;
      const line = await writer.opening(target.request, scoped(opening));
      if (line) await show(line, openingGeneration, { latestOnly: true });
    }),
  );

  return {
    active: () => !closed && (hasWriter || !writerKnown),
    step(text) {
      const mine = ++generation;
      // The opening says nothing has happened yet; once a step starts, it is out of date.
      opening.abort();
      const controller = new AbortController();
      steps.push(controller);
      cancelSteps(2);
      void bestEffort(
        "write step status",
        writer.then((writer) => writer?.step(target.request, text, scoped(controller))),
      ).then((line) =>
        // Without an answer, the step's own line shows, but only while it is the newest step.
        line ? show(line, mine) : show(text, mine, { latestOnly: true }),
      );
    },
    supersede() {
      // Every streamed text delta supersedes; only the first after a status has work to do.
      if (supersededAt === generation) return;
      generation += 1;
      supersededAt = generation;
      opening.abort();
      cancelSteps(0);
    },
    restore() {
      if (lastShown && lastShown.generation > supersededAt)
        void show(lastShown.text, lastShown.generation, { again: true });
    },
    close,
  };
}
