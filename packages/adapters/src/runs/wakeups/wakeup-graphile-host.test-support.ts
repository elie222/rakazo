import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { JobHelpers, Runner } from "graphile-worker";
import { vi } from "vitest";

export function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "run.forget-secrets": vi.fn(async () => undefined),
    "approval.expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "memory.retain-turn": vi.fn(async () => undefined),
    "memory.purge-history": vi.fn(async () => undefined),
    "messaging.send": vi.fn(async () => undefined),
    "messaging.inbound_settle": vi.fn(async () => undefined),
    "messaging.reply": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.progress": vi.fn(async () => undefined),
    "secret.cleanup": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "connection.cleanup": vi.fn(async () => undefined),
    "computer.machine-cleanup": vi.fn(async () => undefined),
    "team_chat.engage": vi.fn(async () => undefined),
    "team_chat.ambient": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "meeting.calendar-sync": vi.fn(async () => undefined),
    "meeting.work": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "media.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
    "email.lifecycle": vi.fn(async () => undefined),
  };
}

export function mockRunner(stop?: () => Promise<void>) {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    // As in Graphile, the runner's promise settles once the shutdown stop() waits for is done.
    stop: vi.fn(async () => {
      await stop?.();
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    resolveLife: () => life.resolve(),
    rejectLife: (error: unknown) => life.reject(error),
  };
}

/**
 * A runner whose pool Graphile already began shutting down by itself, as after a breaking
 * migration notice or a fatal job write: stop() skips the pool, which is no longer active,
 * and returns at once, while the runner's promise still waits for that shutdown.
 */
export function selfStoppingRunner() {
  const graphile = mockRunner();
  vi.mocked(graphile.runner.stop).mockImplementation(async () => undefined);
  return graphile;
}

/** A runner whose shutdown never completes, as against a database that stopped answering. */
export function stalledRunner() {
  return mockRunner(() => new Promise<void>(() => undefined));
}

/** What Graphile hands a task besides its payload: here, a first try of the default 25. */
export const helpers = { job: { id: "1", attempts: 1, max_attempts: 25 } } as unknown as JobHelpers;

/** Reports whether a promise has settled, for tests that step fake timers. */
export function settles(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/** The stop bounds the lifecycle tests run with, on fake timers. */
export const IDLE_MS = 25;
export const DRAIN_MS = 60_000;

export const tooMany = Object.assign(new Error("sorry, too many clients already"), {
  code: "53300",
});
