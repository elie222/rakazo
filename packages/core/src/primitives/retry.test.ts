import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil, retry } from "./retry.js";
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "./retry-policy.js";

afterEach(() => {
  vi.useRealTimers();
});

const withStatus = (status: number, extra: object = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

function failing(failures: unknown[], value = "done") {
  return vi.fn(async () => {
    if (failures.length > 0) throw failures.shift();
    return value;
  });
}

const recordedDelay = () => vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);

describe("retry", () => {
  it("returns the first success and waits the shared backoff between tries", async () => {
    const operation = failing([withStatus(503), new TypeError("fetch failed"), withStatus(429)]);
    const delay = recordedDelay();
    await expect(retry(operation, { attempts: 4, delay, random: () => 0 })).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(4);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1_000]);
  });

  it("jitters the shared backoff and caps it", async () => {
    const operation = failing(Array.from({ length: 9 }, () => withStatus(500)));
    const delay = recordedDelay();
    await retry(operation, { attempts: 10, delay, random: () => 1 });
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([
      125, 250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
  });

  it("waits what the server asked for, bounded", async () => {
    const asked = (header: string) =>
      withStatus(429, { retryAfterMs: parseRetryAfter(header, Date.UTC(2026, 0, 1)) });
    const operation = failing([
      asked("7"),
      asked(new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toUTCString()),
      asked("86400"),
    ]);
    const delay = recordedDelay();
    await retry(operation, { attempts: 4, delay });
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([7_000, 3_000, MAX_RETRY_AFTER_MS]);
  });

  it("rejects at once with an error that cannot succeed on a retry", async () => {
    const forbidden = withStatus(403);
    const operation = failing([forbidden]);
    const delay = recordedDelay();
    await expect(retry(operation, { attempts: 5, delay })).rejects.toBe(forbidden);
    expect(operation).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("rejects with the last failure once the tries run out", async () => {
    const last = withStatus(503);
    const operation = failing([withStatus(500), withStatus(502), last, withStatus(504)]);
    await expect(retry(operation, { attempts: 3, delay: recordedDelay() })).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("lets the caller decide what is retryable, without asking on the last try", async () => {
    const busy = new Error("busy");
    const retryable = vi.fn(async (error: unknown) => error === busy);
    const operation = failing([busy, busy, busy]);
    await expect(retry(operation, { attempts: 3, delayMs: 0, retryable })).rejects.toBe(busy);
    expect(retryable).toHaveBeenCalledTimes(2);
    await expect(
      retry(failing([new Error("other")]), { attempts: 3, delayMs: 0, retryable }),
    ).rejects.toThrow("other");
  });

  it.each([
    ["one value", 40, [40, 40, 40]],
    ["a list whose last entry repeats", [10, 20], [10, 20, 20]],
    [
      "a function of the failed try and its error",
      (attempt: number, error: unknown) =>
        100 * 2 ** attempt + (error as { status: number }).status,
      [600, 700, 900],
    ],
  ] as const)("waits exactly the caller's delay given as %s", async (_name, delayMs, waits) => {
    const delay = recordedDelay();
    const operation = failing([withStatus(500), withStatus(500), withStatus(500)]);
    await retry(operation, { attempts: 4, delayMs, delay, random: () => 1 });
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual(waits);
  });

  it("does not wait at all for a zero delay", async () => {
    const delay = recordedDelay();
    await retry(failing([withStatus(500)]), { attempts: 2, delayMs: 0, delay });
    expect(delay).not.toHaveBeenCalled();
  });

  it("reports each failure it is about to retry", async () => {
    const first = withStatus(500);
    const second = withStatus(502);
    const onRetry = vi.fn();
    await retry(failing([first, second]), {
      attempts: 3,
      delayMs: [5, 9],
      delay: recordedDelay(),
      onRetry,
    });
    expect(onRetry.mock.calls).toEqual([
      [first, 0, 5],
      [second, 1, 9],
    ]);
  });

  it("rejects with the signal's reason as soon as it aborts during a wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = failing([withStatus(500)]);
    const result = retry(operation, { attempts: 3, delayMs: 60_000, signal: controller.signal });
    const settled = expect(result).rejects.toBe("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("cancelled");
    await settled;
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start another try when an injected delay returns after the abort", async () => {
    const controller = new AbortController();
    const operation = failing([withStatus(500)]);
    const delay = vi.fn(async () => controller.abort("cancelled"));
    await expect(
      retry(operation, { attempts: 3, delayMs: 5, delay, signal: controller.signal }),
    ).rejects.toBe("cancelled");
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("pollUntil", () => {
  it("resolves with the first value found, looking again after each interval", async () => {
    vi.useFakeTimers();
    const looks: number[] = [];
    const started = Date.now();
    const answers = [undefined, null, false, 0];
    const result = pollUntil(
      () => {
        looks.push(Date.now() - started);
        return answers.shift();
      },
      { intervalMs: 500, timeoutMs: 10_000, waitingFor: "the answer" },
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toBe(0);
    expect(looks).toEqual([0, 500, 1_000, 1_500]);
  });

  it("grows the interval from the number of looks so far", async () => {
    vi.useFakeTimers();
    const looks: number[] = [];
    const started = Date.now();
    const result = pollUntil(
      async () => {
        looks.push(Date.now() - started);
        return looks.length === 4;
      },
      {
        intervalMs: (count) => Math.min(100 * 2 ** (count - 1), 300),
        timeoutMs: 10_000,
        waitingFor: "the answer",
      },
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toBe(true);
    expect(looks).toEqual([0, 100, 300, 600]);
  });

  it("rejects naming what it waited for once the deadline has passed", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    const result = pollUntil(check, {
      intervalMs: 400,
      timeoutMs: 1_000,
      waitingFor: "the pod to become ready",
    });
    const settled = expect(result).rejects.toThrow(
      "Timed out after 1000 ms waiting for the pod to become ready",
    );
    await vi.advanceTimersByTimeAsync(1_200);
    await settled;
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("settles as onTimeout does instead, returning or throwing", async () => {
    vi.useFakeTimers();
    const gaveUp = pollUntil(() => false, {
      intervalMs: 400,
      timeoutMs: 0,
      onTimeout: () => "gave up" as const,
    });
    await expect(gaveUp).resolves.toBe("gave up");
    const unavailable = new Error("unavailable");
    await expect(
      pollUntil(() => null, {
        intervalMs: 400,
        timeoutMs: 0,
        onTimeout: () => {
          throw unavailable;
        },
      }),
    ).rejects.toBe(unavailable);
  });

  it("rejects with the signal's reason as soon as it aborts during a wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const check = vi.fn(() => undefined);
    const result = pollUntil(check, {
      intervalMs: 60_000,
      timeoutMs: 600_000,
      signal: controller.signal,
      waitingFor: "the answer",
    });
    const settled = expect(result).rejects.toBe("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("cancelled");
    await settled;
    expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends with the error a look throws", async () => {
    const gone = new Error("gone");
    await expect(
      pollUntil(
        () => {
          throw gone;
        },
        { intervalMs: 400, timeoutMs: 1_000, waitingFor: "the answer" },
      ),
    ).rejects.toBe(gone);
  });
});
