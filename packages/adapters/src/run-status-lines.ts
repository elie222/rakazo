import type { StatusLineWriter } from "./status-lines.js";

/** How long each opening status stays before the next one, while the model has not acted yet. */
export const OPENING_STATUS_ROTATION_MS = 3_500;

export type LiveStatusLines = {
  /** Whether a status model is writing statuses; false until it is known, and without one. */
  active(): boolean;
  /**
   * A step the status model words for the person. Without an answer, a tool's own description
   * shows instead; the bot's own text (`fallback: false`) never shows as written.
   */
  step(text: string, options?: { fallback?: boolean }): void;
  /** Something else now owns the working line: the model's own status, or its reply text. */
  supersede(): void;
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
  /** The run's own abort: when it fires, every pending status request stops too. */
  signal?: AbortSignal;
  /** Shows one status as the working line. */
  show(text: string): Promise<unknown>;
  /** Whether the bot's own note holds the working line right now. */
  held(): boolean;
};

/**
 * Runs the member's status model alongside the run: a few opening statuses rotate as soon as
 * they are ready, while the run sets up and the main model thinks, and each step it starts
 * without a status of its own gets one. A status shows only while nothing newer took over, and
 * statuses are shown one at a time, in order.
 */
export function startStatusLines(target: StatusLineTarget): LiveStatusLines {
  const abort = new AbortController();
  const onRunAbort = () => close();
  let generation = 0;
  let closed = false;
  let hasWriter = false;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  // The request for whatever the line shows now; a newer step or status cancels it.
  let current = new AbortController();
  const replaceCurrent = () => {
    current.abort();
    current = new AbortController();
    return AbortSignal.any([abort.signal, current.signal]);
  };
  // Each status waits for the one before it, so a slow write never lands after a newer one.
  let showing: Promise<unknown> = Promise.resolve();
  const stopRotation = () => {
    if (rotation) clearTimeout(rotation);
    rotation = undefined;
  };
  const show = (text: string, mine: number) => {
    showing = showing.then(async () => {
      if (closed || mine !== generation || target.held()) return;
      await target.show(text).catch(() => {});
    });
    return showing;
  };

  // The writer, once the run's credentials are known; nothing is sent to the model before.
  const writer = Promise.all([target.writer, target.ready]).then(([found]) => found);
  void target.writer.then(
    (found) => {
      hasWriter = Boolean(found);
    },
    () => {},
  );
  function close() {
    closed = true;
    stopRotation();
    abort.abort();
    target.signal?.removeEventListener("abort", onRunAbort);
  }
  if (target.signal?.aborted) close();
  else target.signal?.addEventListener("abort", onRunAbort, { once: true });

  const opening = ++generation;
  void writer
    .then(async (writer) => {
      if (!writer || closed) return;
      const lines = await writer.opening(
        target.request,
        AbortSignal.any([abort.signal, current.signal]),
      );
      let index = 0;
      const next = async () => {
        if (closed || opening !== generation || index >= lines.length) return;
        await show(lines[index++]!, opening);
        if (index < lines.length) {
          rotation = setTimeout(() => void next(), OPENING_STATUS_ROTATION_MS);
          rotation.unref?.();
        }
      };
      await next();
    })
    .catch(() => {});

  return {
    active: () => hasWriter && !closed,
    step(text, { fallback = true } = {}) {
      const mine = ++generation;
      stopRotation();
      const signal = replaceCurrent();
      void writer
        .then((writer) => writer?.step(target.request, text, signal))
        .catch(() => undefined)
        .then((line) => {
          const shown = line || (fallback ? text : undefined);
          if (shown) return show(shown, mine);
        })
        .catch(() => {});
    },
    supersede() {
      generation += 1;
      stopRotation();
      replaceCurrent();
    },
    close,
  };
}
