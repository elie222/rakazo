import type { StatusLineWriter } from "./status-lines.js";

/** How long each opening status stays before the next one, while the model has not acted yet. */
export const OPENING_STATUS_ROTATION_MS = 3_500;

export type LiveStatusLines = {
  /** Whether a status model is writing statuses; false until it is known, and without one. */
  active(): boolean;
  /** A step the runtime described technically; the status model words it for the person. */
  step(technical: string): void;
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
  let generation = 0;
  let closed = false;
  let hasWriter = false;
  let rotation: ReturnType<typeof setTimeout> | undefined;
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

  const opening = ++generation;
  void target.writer
    .then(async (writer) => {
      hasWriter = Boolean(writer);
      if (!writer || closed) return;
      const lines = await writer.opening(target.request, abort.signal);
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
    step(technical) {
      const mine = ++generation;
      stopRotation();
      void target.writer
        .then((writer) => writer?.step(target.request, technical, abort.signal))
        .then((line) => {
          if (line) return show(line, mine);
        })
        .catch(() => {});
    },
    supersede() {
      generation += 1;
      stopRotation();
    },
    close() {
      closed = true;
      stopRotation();
      abort.abort();
    },
  };
}
