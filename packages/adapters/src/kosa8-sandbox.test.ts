import { describe, expect, it, vi } from "vitest";
import { Kosa8ApiError, nativeKosa8Api, readExecStream } from "./kosa8-api.js";
import {
  buildKosa8ComputerSnapshot,
  kosa8ComputerSnapshot,
  kosa8Desktop,
} from "./kosa8-sandbox.js";
import { emulatedKosa8, Kosa8Emulator } from "./kosa8-sandbox.test-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import {
  assertSandboxWorkspaceContract,
  MachineRecords,
  settleMachineCleanup,
} from "./sandbox-test-support.js";

const ctx = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const request = { botId: "bot", homePath: "/unused" };

async function started(emulator = new Kosa8Emulator()) {
  const kosa8 = emulatedKosa8(emulator).provider();
  const computer = await kosa8.provision(request, ctx);
  await kosa8.prepare(computer, ctx);
  return { emulator, provider: kosa8, computer };
}

async function run(
  provider: Awaited<ReturnType<typeof started>>["provider"],
  computer: Awaited<ReturnType<typeof started>>["computer"],
  timeoutMs: number,
  context = ctx,
) {
  const events = [];
  for await (const event of provider.execute(
    computer,
    { argv: ["sleep", "infinity"], timeoutMs },
    context,
  ))
    events.push(event);
  return events;
}

describe("kosa8 computer backend", () => {
  it("starts a desktop computer from the saved snapshot, its home linked and gateway published", async () => {
    const { emulator, provider, computer } = await started();
    expect(provider.describe()).toMatchObject({ id: "kosa8", capabilities: { graphical: true } });
    expect(provider.billsWhileRunning()).toBe(true);
    expect(computer).toMatchObject({ kind: "kosa8", fresh: true });
    const machine = emulator.computers.get(computer.id)!;
    expect(machine.snapshot).toBe("snap_standard");
    expect(machine.labels).toMatchObject({ botId: "bot", rakazo: "computer" });
    expect(machine.sleepAfterS).toBe(1_800);
    expect(machine.published).toEqual(new Set([6100]));
    expect(emulator.commands[0]).toContain("ln -s /workspace/user /home/user");
    const screen = await provider.connectScreen(computer, { view: "stream" }, ctx);
    expect(new URL(screen.url!).host).toBe(`6100-${computer.id.slice(4)}.kosa8labs.test`);
  });

  it("keeps the workspace contract", async () => {
    const { provider, computer } = await started();
    await assertSandboxWorkspaceContract(provider, computer, ctx);
  });

  it("keeps the home in /workspace, where the file API reaches it", async () => {
    const { emulator, provider, computer } = await started();
    await provider.writeFile(
      computer,
      { path: "notes/a b.txt", content: new TextEncoder().encode("hi") },
      ctx,
    );
    const { files } = emulator.computers.get(computer.id)!;
    expect(files.has("/workspace/user/rakazo-home/notes/a b.txt")).toBe(true);
    files.set("/workspace/user/rakazo-home/notes/deep/x", {
      content: new Uint8Array(1),
      mode: 0o644,
    });
    expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
      { path: "notes/a b.txt", kind: "file", size: 2 },
      { path: "notes/deep", kind: "dir", size: 4096 },
    ]);
  });

  it("sleeps on stop, wakes on the next start, and deletes on destroy", async () => {
    const { emulator, provider, computer } = await started();
    await provider.stop(computer, ctx);
    expect(emulator.computers.get(computer.id)!.state).toBe("sleeping");
    expect(await provider.isRunning(computer, ctx)).toBe(false);
    await provider.stop(computer, ctx);
    expect(emulator.requests.filter((entry) => entry.startsWith("sleep "))).toHaveLength(1);
    const resumed = await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "kosa8" },
      ctx,
    );
    expect(resumed).toMatchObject({ id: computer.id, fresh: false });
    expect(emulator.requests).toContain(`wake ${computer.id}`);
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
    await provider.destroy(computer, ctx);
    expect(emulator.computers.has(computer.id)).toBe(false);
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    await expect(provider.stop(computer, ctx)).resolves.toBeUndefined();
  });

  it("replaces a deleted computer, but not one missing a file", async () => {
    const { emulator, provider, computer } = await started();
    await expect(provider.readFile(computer, "missing.txt", ctx)).rejects.toSatisfy(
      (error) => !isSandboxGoneError(error),
    );
    emulator.computers.delete(computer.id);
    await expect(provider.isRunning(computer, ctx)).resolves.toBe(false);
    const replaced = await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "kosa8" },
      ctx,
    );
    expect(replaced.id).not.toBe(computer.id);
    expect(replaced.fresh).toBe(true);
  });

  it("reports a rate limit as one, and an unpaid account as the operator's", async () => {
    const emulator = new Kosa8Emulator();
    emulator.refuseCreate = { status: 429, code: "rate_limited" };
    await expect(emulatedKosa8(emulator).provider().provision(request, ctx)).rejects.toMatchObject({
      name: "SandboxRateLimitError",
    });
    emulator.refuseCreate = { status: 402, code: "plan_required" };
    await expect(emulatedKosa8(emulator).provider().provision(request, ctx)).rejects.toMatchObject({
      name: "SandboxProviderAccountError",
    });
  });

  it("deletes a new computer whose setup failed", async () => {
    const emulator = new Kosa8Emulator();
    emulator.fails = (command) => command.includes("ln -s");
    await expect(emulatedKosa8(emulator).provider().provision(request, ctx)).rejects.toThrow(
      "permission denied",
    );
    expect(emulator.computers.size).toBe(0);
  });

  it("ends a command at its deadline with exit 124, keeping the computer running", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    const events = await run(provider, computer, 50);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
  });

  it("ends a cancelled command and everything it started, not only its stream", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    const controller = new AbortController();
    const finished = run(provider, computer, 60_000, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(emulator.computers.get(computer.id)!.running.size).toBe(1));
    controller.abort();
    const events = await finished;
    expect(events.at(-1)).toEqual({ type: "exit", code: 130 });
    expect(emulator.ended).toHaveLength(1);
    expect(emulator.requests.some((entry) => entry.startsWith("sleep "))).toBe(false);
  });

  it("puts the computer to sleep when a cancelled command cannot be ended", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    emulator.endRun = () => new Error("connection reset");
    const controller = new AbortController();
    const finished = run(provider, computer, 60_000, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(emulator.computers.get(computer.id)!.running.size).toBe(1));
    controller.abort();
    await expect(finished).rejects.toMatchObject({ name: "SandboxUnsafeStopError" });
    const fenceAt = emulator.requests.indexOf(`fence ${computer.id}`);
    const sleepAt = emulator.requests.indexOf(`sleep ${computer.id}`);
    expect(fenceAt).toBeGreaterThanOrEqual(0);
    expect(sleepAt).toBeGreaterThan(fenceAt);
    expect(emulator.computers.get(computer.id)!.state).toBe("sleeping");
  });

  it("reports a computer deleted during a command as gone", async () => {
    const { emulator, provider, computer } = await started();
    emulator.computers.delete(computer.id);
    await expect(run(provider, computer, 1_000)).rejects.toSatisfy(isSandboxGoneError);
  });

  it("runs a script longer than kosa8 takes inline from a file it then removes", async () => {
    const { emulator, provider, computer } = await started();
    const long = `x${"y".repeat(9_000)}`;
    let stdout = "";
    for await (const event of provider.execute(computer, { argv: ["echo", long] }, ctx))
      if (event.type === "stdout") stdout += event.data;
    expect(stdout.trim()).toBe(long);
    const { files } = emulator.computers.get(computer.id)!;
    expect([...files.keys()].some((path) => path.startsWith("/workspace/.rakazo-transfer/"))).toBe(
      false,
    );
  });

  it("moves files outside /workspace through it", async () => {
    const emulator = new Kosa8Emulator();
    const { id } = await emulator.create({
      name: "n",
      labels: {},
      sleepAfterS: 0,
      snapshot: "snap_standard",
    });
    const files = emulator.computers.get(id)!.files;
    files.set("/etc/rakazo-test", { content: new TextEncoder().encode("outside"), mode: 0o644 });
    const desktop = kosa8Desktop(emulator, id, "host.test", async () => {});
    const read = await desktop.files.read("/etc/rakazo-test", { format: "bytes" });
    expect(new TextDecoder().decode(read)).toBe("outside");
    await desktop.files.write(
      [{ path: "/tmp/in", data: new TextEncoder().encode("in").buffer }],
      {},
    );
    expect(new TextDecoder().decode(files.get("/tmp/in")!.content)).toBe("in");
    const staged = [...files.keys()].filter((path) =>
      path.startsWith("/workspace/.rakazo-transfer/"),
    );
    expect(staged).toEqual([]);
  });

  it("keeps the computer when a liveness check is rate limited", async () => {
    vi.useFakeTimers();
    try {
      const { emulator, provider, computer } = await started();
      const wakes = emulator.requests.filter((entry) => entry.startsWith("wake "));
      emulator.rateLimited = 1;
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(provider.listFiles(computer, "", ctx)).resolves.toEqual([]);
      expect(emulator.requests.filter((entry) => entry.startsWith("wake "))).toEqual(wakes);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("kosa8 computer snapshots and sizes", () => {
  it("starts from the pool, installs the desktop itself, and saves the snapshot in the background", async () => {
    const emulator = new Kosa8Emulator({ snapshots: false });
    const kosa8 = emulatedKosa8(emulator).provider();
    const computer = await kosa8.provision(request, ctx);
    const machine = emulator.computers.get(computer.id)!;
    expect(machine.template).toBe("universal-4x8");
    expect(machine.snapshot).toBeUndefined();
    expect(emulator.commands.some((command) => command.includes("google-chrome"))).toBe(true);
    await vi.waitFor(() =>
      expect(emulator.saved.map((entry) => entry.name)).toEqual([
        kosa8ComputerSnapshot("standard"),
      ]),
    );
    // The build computer is deleted once its snapshot is saved.
    await vi.waitFor(() => expect(emulator.computers.size).toBe(1));
  });

  it("builds a snapshot from a fresh computer once, and not again when it is saved", async () => {
    const emulator = new Kosa8Emulator({ snapshots: false });
    await expect(buildKosa8ComputerSnapshot(emulator, "large")).resolves.toEqual({
      name: kosa8ComputerSnapshot("large"),
      built: true,
    });
    expect(emulator.requests).toContain("create template universal-8x16");
    expect(emulator.computers.size).toBe(0);
    await expect(buildKosa8ComputerSnapshot(emulator, "large")).resolves.toMatchObject({
      built: false,
    });
  });

  it("falls back to the pool when the snapshot was deleted", async () => {
    const emulator = new Kosa8Emulator();
    const kosa8 = emulatedKosa8(emulator).provider();
    emulator.saved.splice(0, emulator.saved.length);
    const computer = await kosa8.provision(request, ctx);
    expect(emulator.computers.get(computer.id)!.template).toBe("universal-4x8");
  });

  it("starts at the plan's size, and reports one the kosa8 plan does not offer as unavailable", async () => {
    const emulator = new Kosa8Emulator({ snapshots: false });
    const kosa8 = emulatedKosa8(emulator).provider();
    const large = await kosa8.provision({ ...request, size: "large" }, ctx);
    expect(emulator.computers.get(large.id)!.template).toBe("universal-8x16");
    await expect(kosa8.provision({ ...request, size: "xlarge" }, ctx)).rejects.toMatchObject({
      name: "SandboxSizeUnavailableError",
      reason: "not_offered",
    });
  });

  describe("a computer created by a start that then fails", () => {
    const unpublished = new Error("gateway refused");
    function start(emulator: Kosa8Emulator, records?: MachineRecords) {
      vi.spyOn(emulator, "publish").mockRejectedValue(unpublished);
      const kosa8 = emulatedKosa8(emulator, records).provider();
      return settleMachineCleanup(() => kosa8.provision(request, ctx));
    }

    it("is deleted, trying a failed delete again", async () => {
      const emulator = new Kosa8Emulator();
      const remove = emulator.delete.bind(emulator);
      vi.spyOn(emulator, "delete")
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockImplementation(remove);
      const { error, left } = await start(emulator);
      expect(error).toBe(unpublished);
      expect(emulator.computers.size).toBe(0);
      expect(left).toEqual([]);
    });

    it("is handed to the records when it cannot be deleted", async () => {
      const emulator = new Kosa8Emulator();
      vi.spyOn(emulator, "delete").mockRejectedValue(new Error("connection reset"));
      const records = new MachineRecords();
      await start(emulator, records);
      expect([...records.due.values()].map((entry) => entry.machine)).toEqual([
        { provider: "kosa8", machineId: "sbx_test1", homeKey: "bot" },
      ]);
    });
  });

  it("deletes a computer from its id alone, and counts one already gone as deleted", async () => {
    const emulator = new Kosa8Emulator();
    const kosa8 = emulatedKosa8(emulator).provider();
    const computer = await kosa8.provision(request, ctx);
    const machine = { provider: "kosa8", machineId: computer.providerRef };
    const signal = AbortSignal.timeout(5_000);
    await kosa8.deleteMachine(machine, signal);
    expect(emulator.computers.size).toBe(0);
    await expect(kosa8.deleteMachine(machine, signal)).resolves.toBeUndefined();
  });
});

describe("kosa8 API client", () => {
  const stream = (lines: string[]) =>
    new Response(new Blob([lines.map((line) => `${line}\n`).join("")]).stream());

  it("reads a streamed command's output and exit status", async () => {
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    await expect(
      readExecStream(
        stream([
          `{"stream":"stdout","data":"${b64("one\n")}"}`,
          `{"stream":"stderr","data":"${b64("two\n")}"}`,
          '{"done":true,"exit":3}',
        ]),
      ),
    ).resolves.toEqual({ exitCode: 3, stdout: "one\n", stderr: "two\n" });
    await expect(readExecStream(stream(['{"done":true,"error":"host lost"}']))).rejects.toThrow(
      "host lost",
    );
    await expect(readExecStream(stream([]))).rejects.toThrow("ended before the command exited");
  });

  it("sends the key, starts persistent computers or from a snapshot, and reads kosa8's errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/sandboxes/sbx_gone"))
        return Response.json({ error: "not_found", message: "no such sandbox" }, { status: 404 });
      if (url.endsWith("/v1/snapshots"))
        return Response.json(
          { error: "rate_limited", message: "slow down" },
          { status: 429, headers: { "retry-after": "2" } },
        );
      return Response.json({ sandbox: { id: "sbx_1", state: "running" } }, { status: 201 });
    });
    const api = nativeKosa8Api("test-key", "https://kosa8.test/", fetcher as typeof fetch);
    await api.create({ template: "universal-4x8", name: "n", labels: {}, sleepAfterS: 1800 });
    await api.create({ snapshot: "snap_1", name: "n", labels: {}, sleepAfterS: 1800 });
    expect(calls[0]!.url).toBe("https://kosa8.test/v1/sandboxes");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      template: "universal-4x8",
      persistent: true,
      sleep_after_s: 1800,
    });
    expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty("persistent");
    await expect(api.delete("sbx_gone")).resolves.toBe(false);
    const limited = await api.snapshots().catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(Kosa8ApiError);
    expect(limited).toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 2_000 });
  });
});
