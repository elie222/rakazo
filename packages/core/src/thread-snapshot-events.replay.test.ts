import type { RunStatus } from "@rakazo/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isRunTerminalEvent } from "./events.js";
import { isActive } from "./run-state.js";
import type {
  LiveThreadRun,
  LiveThreadSnapshot,
  ThreadSnapshotEvent,
} from "./thread-snapshot-events.js";
import { activeThreadRuns, reduceThreadSnapshot } from "./thread-snapshot-events.js";

const RUN_IDS = ["run-1", "run-2", "run-3"];
const PAYLOADS: Record<string, Record<string, unknown>> = {
  "run.started": { trigger: "user" },
  "run.waiting_input": { userId: "user-1" },
  "computer.takeover.requested": {},
  "computer.takeover.released": {},
  "run.completed": {},
  "run.failed": { error: "The model stopped responding" },
  "run.cancelled": {},
  "thread.progress": { delta: "Working " },
  "agent.tool.called": { name: "web_search" },
  "agent.tool.completed": {},
  "thread.subagent": { agentId: "helper", name: "Helper", task: "Check", status: "running" },
  "thread.message.created": { messageId: "message-1", role: "bot", blocks: [] },
  "thread.message.updated": { messageId: "message-1", role: "bot", blocks: [] },
  "thread.cleared": {},
};

const unnumbered = fc
  .record({
    type: fc.constantFrom(...Object.keys(PAYLOADS)),
    runId: fc.constantFrom(...RUN_IDS),
    botId: fc.constantFrom("bot-1", "bot-2"),
  })
  .map(
    (event): ThreadSnapshotEvent => ({
      ...event,
      threadId: "thread-1",
      payload: PAYLOADS[event.type],
    }),
  );
const numbered = fc
  .tuple(unnumbered, fc.nat(40))
  .map(([event, seq]): ThreadSnapshotEvent => ({ ...event, seq }));

const snapshot = fc
  .record({
    cursor: fc.option(fc.nat(20), { nil: undefined }),
    running: fc.subarray(RUN_IDS),
    grouped: fc.boolean(),
  })
  .map(({ cursor, running, grouped }): LiveThreadSnapshot => {
    const activeRuns = running.map(
      (id): LiveThreadRun => ({ id, botId: "bot-1", status: "running" }),
    );
    return {
      threadId: "thread-1",
      ...(grouped ? { groupId: "group-1" } : { botId: "bot-1" }),
      cursor,
      olderCursor: null,
      messages: [],
      run: activeRuns[0] ?? null,
      activeRuns,
    };
  });

/** Server order, where each run's ending is the last event it writes. */
const threadLog = fc.array(unnumbered, { minLength: 1, maxLength: 20 }).map((events) => {
  const ended = new Set<string>();
  return events
    .filter((event) => {
      if (!event.runId || ended.has(event.runId)) return false;
      if (isRunTerminalEvent(event)) ended.add(event.runId);
      return true;
    })
    .map((event, index): ThreadSnapshotEvent => ({ ...event, seq: index + 1 }));
});

const deliveries = fc
  .tuple(threadLog, fc.array(fc.nat(), { maxLength: 60 }))
  .map(([log, picks]) => picks.map((pick) => log[pick % log.length]!));

function reduce(current: LiveThreadSnapshot, event: ThreadSnapshotEvent): LiveThreadSnapshot {
  return reduceThreadSnapshot(current, event) as LiveThreadSnapshot;
}

function runIsActive(current: LiveThreadSnapshot, id: string) {
  return [current.run, ...activeThreadRuns(current)].some(
    (run) => run?.id === id && isActive(run.status as RunStatus),
  );
}

describe("thread events delivered late, twice or out of order", () => {
  it("never moves the cursor backward", () => {
    fc.assert(
      fc.property(
        snapshot,
        fc.array(fc.oneof(numbered, unnumbered), { maxLength: 30 }),
        (start, events) => {
          let current = start;
          for (const event of events) {
            const next = reduce(current, event);
            expect(next.cursor ?? -1).toBeGreaterThanOrEqual(current.cursor ?? -1);
            current = next;
          }
        },
      ),
      { seed: 42, numRuns: 300 },
    );
  });

  it("applies any numbered event twice with the same result as once", () => {
    fc.assert(
      fc.property(
        snapshot,
        fc.array(numbered, { maxLength: 12 }),
        numbered,
        (start, earlier, event) => {
          const once = reduce(earlier.reduce(reduce, start), event);
          expect(reduce(once, event)).toBe(once);
        },
      ),
      { seed: 42, numRuns: 300 },
    );
  });

  it("keeps a run ended once its ending is applied, whichever of its events arrive afterward", () => {
    fc.assert(
      fc.property(snapshot, deliveries, (start, events) => {
        let current: LiveThreadSnapshot = { ...start, cursor: 0 };
        const ended = new Set<string>();
        for (const event of events) {
          const next = reduce(current, event);
          if (next !== current && event.runId && isRunTerminalEvent(event)) ended.add(event.runId);
          current = next;
          for (const id of ended) expect(runIsActive(current, id)).toBe(false);
        }
      }),
      { seed: 42, numRuns: 500 },
    );
  });
});
