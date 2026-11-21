import type { ConfigurationOptions, V1Pod } from "@kubernetes/client-node";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFor, readyPod } from "./kubernetes-sandbox.test-support.js";

const request = { botId: "bot-a", homePath: "/unused" };
const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const missing = Object.assign(new Error("missing"), { code: 404 });
const deadline = new Error("request deadline");

async function sdkSignal(options: ConfigurationOptions | undefined) {
  const setSignal = vi.fn();
  await options?.middleware?.[0]?.pre({ setSignal } as never).toPromise();
  expect(setSignal).toHaveBeenCalledOnce();
  return setSignal.mock.calls[0]?.[0] as AbortSignal;
}

describe("Kubernetes pod create requests", () => {
  const sink = createTestSink();
  beforeEach(() => {
    sink.events.length = 0;
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.useFakeTimers();
    // Native AbortSignal.timeout ignores fake timers.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(deadline), ms);
      return controller.signal;
    });
  });

  afterEach(() => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["deadline", "cancellation"])(
    "reconciles and cleans an accepted create after %s before returning its error",
    async (mode) => {
      const controller = new AbortController();
      const cancelled = new Error("run cancelled");
      const createNamespacedPod = vi.fn().mockReturnValue(deferred<V1Pod>().promise);
      const cleanup = deferred<void>();
      const deleteNamespacedPod = vi.fn().mockReturnValue(cleanup.promise);
      const readNamespacedPod = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue(readyPod);
      const provider = providerFor({
        createNamespacedPod,
        readNamespacedPod,
        deleteNamespacedPod,
      });
      let outcome: unknown = "pending";
      const result = provider.provision(request, { ...context, signal: controller.signal });
      const settled = result.catch((error: unknown) => {
        outcome = error;
      });
      await vi.waitFor(() => expect(createNamespacedPod).toHaveBeenCalledOnce());
      const signal = await sdkSignal(createNamespacedPod.mock.calls[0]?.[1]);
      expect(signal.aborted).toBe(false);
      if (mode === "cancellation") controller.abort(cancelled);
      else await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(deleteNamespacedPod).toHaveBeenCalledOnce());
      expect(signal.aborted).toBe(true);
      expect(outcome).toBe("pending");
      expect(readNamespacedPod).toHaveBeenCalledTimes(2);
      const name = createNamespacedPod.mock.calls[0]?.[0].body.metadata.name;
      expect(readNamespacedPod.mock.calls[1]?.[0]).toEqual({ name, namespace: "rakazo-sandboxes" });
      expect(deleteNamespacedPod.mock.calls[0]?.[0]).toMatchObject({ name });
      expect((await sdkSignal(readNamespacedPod.mock.calls[1]?.[1])).aborted).toBe(false);
      expect((await sdkSignal(deleteNamespacedPod.mock.calls[0]?.[1])).aborted).toBe(false);
      cleanup.resolve();
      await settled;
      expect(outcome).toBe(mode === "cancellation" ? cancelled : deadline);
    },
  );

  it.each(["missing", "other bot", "unlabelled", "read fails", "read stalls"])(
    "preserves the create failure without deleting when reconciliation finds %s",
    async (state) => {
      const failure = new Error("connection lost");
      const createNamespacedPod = vi.fn().mockRejectedValue(failure);
      const deleteNamespacedPod = vi.fn();
      const readNamespacedPod = vi.fn().mockRejectedValueOnce(missing);
      if (state === "missing") readNamespacedPod.mockRejectedValue(missing);
      else if (state === "read fails")
        readNamespacedPod.mockRejectedValue(new Error("read failed"));
      else if (state === "read stalls")
        readNamespacedPod.mockReturnValue(deferred<V1Pod>().promise);
      else
        readNamespacedPod.mockResolvedValue({
          metadata: { labels: state === "other bot" ? { "rakazo-bot-id": "bot-b" } : {} },
        });
      const result = providerFor({
        createNamespacedPod,
        readNamespacedPod,
        deleteNamespacedPod,
      }).provision(request, context);
      const assertion = expect(result).rejects.toBe(failure);
      await vi.waitFor(() => expect(readNamespacedPod).toHaveBeenCalledTimes(2));
      if (state === "read stalls") await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(deleteNamespacedPod).not.toHaveBeenCalled();
      expect(sink.events.filter((event) => event.level === "warn")).toHaveLength(
        state === "read fails" || state === "read stalls" ? 1 : 0,
      );
    },
  );

  it("bounds cleanup of an ambiguously accepted create and preserves the original failure", async () => {
    const failure = new Error("connection lost");
    const deleteNamespacedPod = vi.fn().mockReturnValue(deferred<void>().promise);
    const provider = providerFor({
      readNamespacedPod: vi.fn().mockRejectedValueOnce(missing).mockResolvedValue(readyPod),
      createNamespacedPod: vi.fn().mockRejectedValue(failure),
      deleteNamespacedPod,
    });
    const assertion = expect(provider.provision(request, context)).rejects.toBe(failure);
    await vi.waitFor(() => expect(deleteNamespacedPod).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("keeps a conflicting owned pod on the reuse path", async () => {
    const deleteNamespacedPod = vi.fn();
    const provider = providerFor({
      readNamespacedPod: vi.fn().mockRejectedValueOnce(missing).mockResolvedValue(readyPod),
      createNamespacedPod: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("exists"), { code: 409 })),
      deleteNamespacedPod,
    });
    await expect(provider.provision(request, context)).resolves.toMatchObject({ fresh: false });
    expect(deleteNamespacedPod).not.toHaveBeenCalled();
  });
});
