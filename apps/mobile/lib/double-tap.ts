type Point = { x: number; y: number; time: number };

// Close to the platform feel: each tap is short and still, and the second tap starts within
// 300 ms of the first one ending, near the same spot (Android uses 300 ms, iOS a bit more).
const TAP_MAX_MS = 250;
const GAP_MAX_MS = 300;
const TAP_SLOP = 10;
const PAIR_SLOP = 40;

const within = (a: Point, b: Point, slop: number) => Math.hypot(a.x - b.x, a.y - b.y) <= slop;

/** Only completed, short, stationary touches participate in a pair. */
export function createDoubleTapDetector() {
  let start: Point | undefined;
  let previous: Point | undefined;
  const cancel = () => {
    start = undefined;
    previous = undefined;
  };
  return {
    cancel,
    start(point: Point) {
      start = point;
    },
    move(point: Point) {
      if (start && !within(start, point, TAP_SLOP)) {
        cancel();
        return true;
      }
      return false;
    },
    end(point: Point) {
      const first = start;
      start = undefined;
      if (!first || point.time - first.time > TAP_MAX_MS || !within(first, point, TAP_SLOP)) {
        previous = undefined;
        return false;
      }
      if (
        previous &&
        first.time - previous.time <= GAP_MAX_MS &&
        within(previous, point, PAIR_SLOP)
      ) {
        previous = undefined;
        return true;
      }
      previous = point;
      return false;
    },
  };
}

export function canDoubleTapReact(
  includeReact: boolean,
  blocks: readonly { kind: string }[],
  waitingForUser: boolean,
) {
  return (
    includeReact &&
    !waitingForUser &&
    blocks.length > 0 &&
    blocks.every((block) => ["text", "image", "file", "chart"].includes(block.kind))
  );
}
