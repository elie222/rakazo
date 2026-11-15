import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { expect, vi } from "vitest";

/** Deadline signals run on the runtime's own clock; this puts them on the faked one. */
export function fakeDeadlineSignals() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
}

/** A request answered only by its signal ending it, as one to a provider that stalls is. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Runs work that ends by deleting a machine nothing points at, on a faked clock, so neither the
 * pauses between tries nor a try's deadline is waited out. Returns what the work rejected with
 * and the machines it reported as left behind.
 */
export async function settleMachineCleanup(work: () => Promise<unknown>) {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const deadlines = fakeDeadlineSignals();
  try {
    let error: unknown;
    let settled = false;
    void work()
      .catch((failure: unknown) => {
        error = failure;
      })
      .finally(() => {
        settled = true;
      });
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    const left = sink.events
      .filter((event) => event.level === "error" && event.message === "sandbox.cleanup_failed")
      .map(({ provider, machineId }) => ({ provider, machineId }));
    return { error, left };
  } finally {
    deadlines.mockRestore();
    vi.useRealTimers();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  }
}

export async function provisionPrepared(
  provider: SandboxProvider,
  request: Parameters<SandboxProvider["provision"]>[0],
  context: AdapterContext,
) {
  const computer = await provider.provision(request, context);
  await provider.prepare(computer, context);
  return computer;
}

export async function assertSandboxWorkspaceContract(
  provider: SandboxProvider,
  computer: ComputerRef,
  ctx: AdapterContext,
) {
  await provider.prepare(computer, ctx);
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  expect(stdout).toContain("graphical-ok");
  await provider.writeFile(
    computer,
    { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
    ctx,
  );
  expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
    { path: "notes/result.txt", kind: "file", size: 8 },
  ]);
  expect(new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx))).toBe(
    "portable",
  );
  const binary = Uint8Array.from([0, 255, 1, 128]);
  await provider.writeFile(computer, { path: "bin/tool", content: binary, executable: true }, ctx);
  expect(await provider.readFile(computer, "bin/tool", ctx)).toEqual(binary);
  expect(await provider.listFiles(computer, "bin", ctx)).toEqual([
    { path: "bin/tool", kind: "file", size: 4, executable: true },
  ]);
  const acted = await provider.act(
    computer,
    {
      actions: [
        { kind: "clipboard", text: "visible" },
        { kind: "focus", application: "xterm" },
      ],
      observe: true,
    },
    ctx,
  );
  expect(acted.completed).toBe(2);
  expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
  const exported = [];
  for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
  expect(exported.map((file) => file.path)).toContain("notes/result.txt");
  expect(exported.find((file) => file.path === "bin/tool")).toMatchObject({
    content: binary,
    executable: true,
  });
}
