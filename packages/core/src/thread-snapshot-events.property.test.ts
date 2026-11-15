import type { RunStatus } from "@rakazo/contracts";
import { RUN_TRIGGERS, RunStatus as RunStatusSchema } from "@rakazo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canTransition, isActive, isBackgroundRunTrigger, isTerminal } from "./run-state.js";
import type {
  LiveThreadMessage,
  LiveThreadRun,
  LiveThreadSnapshot,
  ThreadSnapshotEvent,
} from "./thread-snapshot-events.js";
import {
  activeThreadRuns,
  mergeThreadSnapshot,
  reduceThreadSnapshot,
} from "./thread-snapshot-events.js";

const RUN_IDS = ["run-1", "run-2", "run-3"] as const;
const BOT_IDS = ["bot-1", "bot-2"] as const;
const CREATED_AT = "2026-08-16T00:00:00.000Z";

const runId = fc.constantFrom(...RUN_IDS);
const scope = fc.record(
  { runId, botId: fc.constantFrom(...BOT_IDS) },
  { requiredKeys: [] },
) as fc.Arbitrary<{ runId?: string; botId?: string }>;
const words = fc.constantFrom("Checking ", "the calendar. ", "Done.", "");

function lifecycle(type: string, payload: fc.Arbitrary<Record<string, unknown>>) {
  return fc
    .tuple(scope, payload)
    .map(([target, payload]): ThreadSnapshotEvent => ({ type, ...target, payload }));
}

const empty = fc.constant({});
const runStarted = lifecycle(
  "run.started",
  fc.record(
    { trigger: fc.constantFrom(...RUN_TRIGGERS), routineName: fc.constant("Morning summary") },
    { requiredKeys: [] },
  ),
);
const runWaiting = fc.oneof(
  lifecycle(
    "run.waiting_input",
    fc.record({ userId: fc.constant("user-1") }, { requiredKeys: [] }),
  ),
  lifecycle("computer.takeover.requested", empty),
);
const runEnded = fc.oneof(
  lifecycle("run.completed", empty),
  lifecycle("run.cancelled", empty),
  lifecycle(
    "run.failed",
    fc.record({ error: fc.constant("The model stopped responding") }, { requiredKeys: [] }),
  ),
);
const textBlock = words.map((text) => ({ kind: "text" as const, text }));
const subagentPayload = fc.record({
  agentId: fc.constantFrom("helper-1", "helper-2"),
  name: fc.constant("Researcher"),
  task: fc.constant("Find the venue"),
  status: fc.constantFrom("running", "completed", "failed"),
});
const messagePayload = fc.record(
  {
    messageId: fc.constantFrom("m-1", "m-2", "m-3"),
    role: fc.constantFrom("bot", "user"),
    blocks: fc.array(
      fc.oneof(
        textBlock,
        subagentPayload.map((block) => ({ kind: "subagent" as const, ...block })),
        fc.constant({
          kind: "cloud_agent" as const,
          agentId: "cloud-1",
          title: "Cloud agent",
          status: "running" as const,
          url: "",
        }),
      ),
      { maxLength: 2 },
    ),
    seq: fc.nat(20),
    callId: fc.constant("call-1"),
  },
  { requiredKeys: ["messageId", "blocks"] },
);
const settingEvent = fc.oneof(
  runStarted,
  runWaiting,
  runEnded,
  lifecycle("computer.takeover.released", empty),
  lifecycle("agent.tool.completed", empty),
  lifecycle("thread.subagent", subagentPayload),
  lifecycle(
    "thread.cloud_agent",
    fc.record({
      agentId: fc.constant("cloud-1"),
      messageId: fc.constantFrom("m-1", "m-2"),
      status: fc.constantFrom("running", "finished"),
    }),
  ),
  lifecycle("thread.message.created", messagePayload),
  lifecycle("thread.message.updated", messagePayload),
  fc.constant<ThreadSnapshotEvent>({ type: "thread.cleared" }),
);
const accumulatingEvent = fc.oneof(
  lifecycle(
    "thread.progress",
    fc.oneof(
      fc.record({ text: words }),
      fc.record({ delta: words }),
      fc.record({ text: words, reset: fc.constant(true) }),
      fc.record({ text: fc.constant("Searching the web"), activity: fc.constant(true) }),
    ),
  ),
  lifecycle("agent.tool.called", fc.record({ name: fc.constantFrom("web_search", "read_file") })),
);
const anyEvent = fc.oneof({ weight: 3, arbitrary: settingEvent }, accumulatingEvent);

const baseSnapshot = fc
  .record(
    {
      groupId: fc.constant("group-1"),
      cursor: fc.nat(5),
      activeRuns: fc.constant<LiveThreadRun[]>([]),
      members: fc.constant(BOT_IDS.map((botId) => ({ botId, status: "idle" }))),
    },
    { requiredKeys: [] },
  )
  .map(
    (optional): LiveThreadSnapshot => ({
      threadId: "thread-1",
      botId: "bot-1",
      olderCursor: null,
      messages: [],
      run: null,
      ...optional,
    }),
  );

/** Events numbered the way a thread stream numbers them, after the snapshot's own cursor. */
function inStreamOrder(snapshot: LiveThreadSnapshot, events: readonly ThreadSnapshotEvent[]) {
  const first = (snapshot.cursor ?? 0) + 1;
  return events.map((event, index) => ({
    ...event,
    id: `event-${first + index}`,
    seq: first + index,
    threadId: snapshot.threadId,
    createdAt: CREATED_AT,
  }));
}

function apply(snapshot: LiveThreadSnapshot, events: readonly ThreadSnapshotEvent[]) {
  return events.reduce(
    (current, event) => reduceThreadSnapshot(current, event) as LiveThreadSnapshot,
    snapshot,
  );
}

/** A snapshot some stream of events could have produced. */
const reachedSnapshot = fc
  .tuple(baseSnapshot, fc.array(anyEvent, { maxLength: 12 }))
  .map(([snapshot, events]) => apply(snapshot, inStreamOrder(snapshot, events)));

function next(snapshot: LiveThreadSnapshot, event: ThreadSnapshotEvent) {
  return inStreamOrder(snapshot, [event])[0] as ThreadSnapshotEvent;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function runIsActive(snapshot: LiveThreadSnapshot, id: string) {
  return [snapshot.run, ...activeThreadRuns(snapshot)].some(
    (run) => run?.id === id && isActive(run.status as RunStatus),
  );
}

type RunSetup = { id: string; botId: string; trigger: string; unseen: boolean };
type LifecycleStep = { run: number; choice: number; progress: boolean };

const lifecycleStep: fc.Arbitrary<LifecycleStep> = fc.record({
  run: fc.nat(RUN_IDS.length - 1),
  choice: fc.nat(11),
  progress: fc.boolean(),
});
const runSetup: fc.Arbitrary<RunSetup[]> = fc.tuple(
  ...RUN_IDS.map((id) =>
    fc.record({
      id: fc.constant(id),
      botId: fc.constantFrom(...BOT_IDS),
      trigger: fc.constantFrom(
        ...RUN_TRIGGERS.filter((trigger) => !isBackgroundRunTrigger(trigger)),
      ),
      unseen: fc.boolean(),
    }),
  ),
);

/**
 * Walks runs through transitions the run state machine allows and returns the events a thread
 * receives for them, the status each run last reported and the runs still streaming a reply.
 * An unseen run is already running when the thread opens, absent from its snapshot.
 */
function runLifecycles(runs: readonly RunSetup[], steps: readonly LifecycleStep[]) {
  const status = new Map<string, RunStatus>(
    runs.map((run) => [run.id, run.unseen ? "running" : "queued"]),
  );
  const shown = new Map<string, string>();
  const streaming = new Set<string>();
  const events: ThreadSnapshotEvent[] = [];
  for (const step of steps) {
    const run = runs[step.run];
    const from = run && status.get(run.id);
    if (!run || !from) continue;
    const target = { runId: run.id, botId: run.botId };
    if (step.progress && from === "running") {
      events.push({ type: "thread.progress", ...target, payload: { delta: "Working " } });
      streaming.add(run.id);
      continue;
    }
    const allowed = RunStatusSchema.options.filter((to) => canTransition(from, to));
    const to = allowed[step.choice % allowed.length];
    if (!to) continue;
    status.set(run.id, to);
    if (to === "running") {
      events.push({ type: "run.started", ...target, payload: { trigger: run.trigger } });
      shown.set(run.id, to);
    } else if (to === "waiting_input" || to === "waiting_takeover") {
      const type = to === "waiting_input" ? "run.waiting_input" : "computer.takeover.requested";
      events.push({ type, ...target });
      shown.set(run.id, to);
      streaming.delete(run.id);
    } else if (isTerminal(to)) {
      events.push({ type: `run.${to}`, ...target, payload: { error: "The model stopped" } });
      shown.delete(run.id);
      streaming.delete(run.id);
    } else if (from === "waiting_takeover") {
      events.push({ type: "computer.takeover.released", ...target });
      shown.set(run.id, "queued");
    }
  }
  return { events, shown, streaming };
}

describe("reduceThreadSnapshot properties", () => {
  it("gives the same result for the same event without changing the snapshot it was given", () => {
    fc.assert(
      fc.property(reachedSnapshot, anyEvent, (snapshot, event) => {
        const frozen = deepFreeze(structuredClone(snapshot));
        const applied = deepFreeze(next(frozen, event));
        expect(reduceThreadSnapshot(frozen, applied)).toEqual(
          reduceThreadSnapshot(frozen, applied),
        );
        expect(frozen).toEqual(snapshot);
      }),
      { seed: 42, numRuns: 150 },
    );
  });

  it("applies a run, message, helper or clear event twice with the same result as once", () => {
    fc.assert(
      fc.property(reachedSnapshot, settingEvent, (snapshot, event) => {
        const applied = next(snapshot, event);
        const once = reduceThreadSnapshot(snapshot, applied);
        expect(reduceThreadSnapshot(once, applied)).toEqual(once);
      }),
      { seed: 42, numRuns: 150 },
    );
  });

  it("moves the cursor to each event of a stream in order and never backward", () => {
    fc.assert(
      fc.property(baseSnapshot, fc.array(anyEvent, { maxLength: 12 }), (snapshot, events) => {
        let current = snapshot;
        for (const event of inStreamOrder(snapshot, events)) {
          const reduced = reduceThreadSnapshot(current, event) as LiveThreadSnapshot;
          expect(reduced.cursor).toBe(event.seq);
          const unnumbered = reduceThreadSnapshot(reduced, { ...event, seq: undefined });
          expect(unnumbered?.cursor).toBe(event.seq);
          current = reduced;
        }
      }),
      { seed: 42, numRuns: 100 },
    );
  });

  it("never holds two messages with the same id", () => {
    fc.assert(
      fc.property(reachedSnapshot, (snapshot) => {
        const ids = snapshot.messages.map((message) => message.id);
        expect(ids).toEqual([...new Set(ids)]);
      }),
      { seed: 42, numRuns: 150 },
    );
  });

  it("keeps an ended run ended through later events that neither start nor pause it", () => {
    fc.assert(
      fc.property(
        reachedSnapshot,
        runId,
        runEnded,
        fc.array(anyEvent, { maxLength: 10 }),
        (snapshot, ended, end, later) => {
          const revives = (event: ThreadSnapshotEvent) =>
            event.runId === ended &&
            ["run.started", "run.waiting_input", "computer.takeover.requested"].includes(
              event.type,
            );
          const events = [{ ...end, runId: ended }, ...later.filter((event) => !revives(event))];
          let current = snapshot;
          for (const event of inStreamOrder(snapshot, events)) {
            current = reduceThreadSnapshot(current, event) as LiveThreadSnapshot;
            expect(runIsActive(current, ended)).toBe(false);
          }
        },
      ),
      { seed: 42, numRuns: 150 },
    );
  });

  it("shows every run in the state its own events last reported, however runs interleave", () => {
    fc.assert(
      fc.property(
        baseSnapshot,
        runSetup,
        fc.array(lifecycleStep, { maxLength: 30 }),
        (snapshot, runs, steps) => {
          const { events, shown, streaming } = runLifecycles(runs, steps);

          const result = apply(snapshot, inStreamOrder(snapshot, events));

          const active = activeThreadRuns(result);
          for (const id of RUN_IDS) {
            expect(active.filter((run) => run.id === id).map((run) => run.status)).toEqual(
              shown.has(id) ? [shown.get(id)] : [],
            );
          }
          if (result.run && result.run.status !== "failed") {
            expect(active.map((run) => `${run.id} ${run.status}`)).toContain(
              `${result.run.id} ${result.run.status}`,
            );
          }
          expect(
            result.messages
              .map((message) => message.id)
              .filter((id) => id.startsWith("progress:"))
              .sort(),
          ).toEqual([...streaming].map((id) => `progress:${id}`).sort());
        },
      ),
      { seed: 42, numRuns: 200 },
    );
  });
});

const page = fc
  .tuple(
    fc.uniqueArray(fc.nat(15), { maxLength: 8 }),
    fc.boolean(),
    fc.option(fc.nat(20), { nil: undefined }),
    fc.option(fc.nat(15), { nil: null }),
    words,
  )
  .map(([seqs, live, cursor, olderCursor, text]): LiveThreadSnapshot => {
    const messages: LiveThreadMessage[] = seqs
      .sort((a, b) => a - b)
      .map((seq) => ({ id: `m-${seq}`, seq, role: "bot", blocks: [{ kind: "text", text }] }));
    if (live) messages.push({ id: "progress:run-1", role: "bot", runId: "run-1", blocks: [] });
    return { threadId: "thread-1", cursor, olderCursor, messages, run: null };
  });

describe("mergeThreadSnapshot properties", () => {
  it("never moves a thread's cursor backward", () => {
    fc.assert(
      fc.property(page, page, fc.boolean(), (previous, refreshed, keepHistory) => {
        const merged = mergeThreadSnapshot(previous, refreshed, keepHistory);
        expect(merged.cursor ?? -1).toBe(Math.max(previous.cursor ?? -1, refreshed.cursor ?? -1));
      }),
      { seed: 42, numRuns: 100 },
    );
  });

  it("applies the same refresh twice with the same result as once", () => {
    fc.assert(
      fc.property(page, page, fc.boolean(), (previous, refreshed, keepHistory) => {
        const once = mergeThreadSnapshot(previous, refreshed, keepHistory);
        expect(mergeThreadSnapshot(once, refreshed, keepHistory)).toEqual(once);
        const ids = once.messages.map((message) => message.id);
        expect(ids).toEqual([...new Set(ids)]);
      }),
      { seed: 42, numRuns: 100 },
    );
  });
});
