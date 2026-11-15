import { RateLimitError } from "@boxd-sh/sdk";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { SandboxRateLimitError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { screenDisplayArgv, shellQuote } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { BoxdSandboxClient } from "./boxd-sandbox.js";
import { BOXD_COMPUTER_SNAPSHOT, BoxdSandboxProvider } from "./boxd-sandbox.js";
import { BOXD_WORKSPACE, FakeBoxd, fakeBoxdProvider } from "./boxd-sandbox.test-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract, settleMachineCleanup } from "./sandbox-test-support.js";

const ctx = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

async function events(
  provider: BoxdSandboxProvider,
  computer: ComputerRef,
  request: Parameters<BoxdSandboxProvider["execute"]>[1],
  context: AdapterContext = ctx,
) {
  const seen: ProcessEvent[] = [];
  for await (const event of provider.execute(computer, request, context)) seen.push(event);
  return seen;
}

describe("boxd computers", () => {
  it("starts isolated computers from the desktop snapshot, with the screen proxy and no boxd idle suspend", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    expect(computer).toMatchObject({ kind: "boxd", fresh: true, providerRef: "machine-1" });
    expect(boxd.machine("machine-1").params).toMatchObject({
      isolated: true,
      fromSnapshot: BOXD_COMPUTER_SNAPSHOT,
      config: { autoSuspendTimeout: 0 },
    });
    await assertSandboxWorkspaceContract(provider, computer, ctx);
    // A snapshot boot does not take proxies at create, so preparing adds the screen proxy once.
    expect(boxd.machine("machine-1").proxies).toEqual(new Map([["screen", 6100]]));
    await provider.prepare(computer, ctx);
    expect(boxd.calls.filter((call) => call === "proxies.create")).toHaveLength(1);
  });

  it("boots the stock image and builds the snapshot once in the background when it is missing", async () => {
    const boxd = new FakeBoxd();
    const provider = new BoxdSandboxProvider({}, boxd.client());

    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    expect(boxd.machine(computer.providerRef).params).not.toHaveProperty("fromSnapshot");
    await provider.provision({ botId: "other", homePath: "/unused" }, ctx);
    await expect.poll(() => boxd.snapshots.get(BOXD_COMPUTER_SNAPSHOT)).toBe("ready");

    // One build machine, deleted once the snapshot was saved, and later computers use it.
    expect(boxd.calls.filter((call) => call === "snapshots.create")).toHaveLength(1);
    expect([...boxd.machines.values()].map((machine) => machine.name)).not.toContainEqual(
      expect.stringMatching(/^rakazo-snapshot-/),
    );
    const next = await provider.provision({ botId: "third", homePath: "/unused" }, ctx);
    expect(boxd.machine(next.providerRef).params).toMatchObject({
      fromSnapshot: BOXD_COMPUTER_SNAPSHOT,
    });
  });

  it("reports whether a reconnect had to wake or start the computer", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const { providerRef } = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const reconnect = () =>
      provider.provision(
        { botId: "bot", homePath: "/unused", providerRef, providerKind: "boxd" },
        ctx,
      );

    expect(await reconnect()).toMatchObject({ providerRef, fresh: false, started: false });
    boxd.machine(providerRef).status = "suspended";
    expect(await reconnect()).toMatchObject({ providerRef, started: true });
    boxd.machine(providerRef).status = "stopped";
    expect(await reconnect()).toMatchObject({ providerRef, started: true });
    expect(boxd.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  it("replaces a computer boxd no longer has", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const gone = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    boxd.machines.delete(gone.providerRef);

    const replacement = await provider.provision(
      { botId: "bot", homePath: "/unused", providerRef: gone.providerRef, providerKind: "boxd" },
      ctx,
    );
    expect(replacement).toMatchObject({ fresh: true });
    expect(replacement.providerRef).not.toBe(gone.providerRef);
    await expect(provider.prepare(gone, ctx)).rejects.toSatisfy(isSandboxGoneError);
  });

  it("keeps command environment values out of the command line", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    expect(
      await events(provider, computer, {
        argv: ["printenv", "TOKEN"],
        env: { TOKEN: "secret value" },
        cwd: "notes",
      }),
    ).toEqual([
      { type: "stdout", data: "secret value\n" },
      { type: "exit", code: 0 },
    ]);
    const sent = boxd.commands.at(-1)!;
    expect(sent.command).not.toContain("secret value");
    expect(sent.cwd).toBe(`${BOXD_WORKSPACE}/notes`);
    // The command removed its environment file as it started.
    expect([...boxd.machine(computer.providerRef).files.keys()]).not.toContainEqual(
      expect.stringContaining(".rakazo-command-env/"),
    );
  });

  it("runs a bot's commands on that bot's own screen unless the caller chose a display", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "beto", homePath: "/unused" }, ctx);
    const sent = async (
      request: { argv: string[]; env?: Record<string, string> },
      context: AdapterContext = ctx,
    ) => {
      await events(provider, computer, request, context);
      return boxd.commands.at(-1)!.command;
    };
    const argv = ["ffmpeg", "-f", "x11grab", "out.mp4"];

    expect(await sent({ argv }, { ...ctx, botId: "beto" })).toContain(
      screenDisplayArgv(argv, "beto", 20).map(shellQuote).join(" "),
    );
    expect(await sent({ argv })).toBe(argv.map(shellQuote).join(" "));
    expect(await sent({ argv, env: { DISPLAY: ":0" } }, { ...ctx, botId: "beto" })).not.toContain(
      "desktop-assignments",
    );
  });

  it("reports exit codes and stderr, and stops commands that time out or are aborted", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    expect(await events(provider, computer, { argv: ["fail", "3", "broken"] })).toEqual([
      { type: "stderr", data: "broken\n" },
      { type: "exit", code: 3 },
    ]);
    expect(await events(provider, computer, { argv: ["sleep", "60"], timeoutMs: 50 })).toEqual([
      { type: "stderr", data: "command timed out after 50 ms\n" },
      { type: "exit", code: 124 },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(
      await events(
        provider,
        computer,
        { argv: ["sleep", "60"] },
        { ...ctx, signal: controller.signal },
      ),
    ).toEqual([
      { type: "stderr", data: "command aborted\n" },
      { type: "exit", code: 130 },
    ]);
    expect(boxd.running.size).toBe(0);
  });

  it("waits for the machine's HTTPS proxy, then serves screens through it with a per-screen token", async () => {
    const provider = fakeBoxdProvider();
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    // No certificate yet, then boxd's proxy reports the address ready.
    const probe = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new Response(null, { headers: { "x-boxd-proxy": "ready" } }));
    vi.stubGlobal("fetch", probe);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      ctx,
    );
    const url = new URL(screen.url!);

    expect(url.origin).toMatch(/^https:\/\/screen\.rakazo-[0-9a-f]{20}\.boxd\.test$/);
    expect(url.pathname).toBe("/vnc.html");
    expect(url.searchParams.get("path")).toMatch(/token=view-/);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(String(probe.mock.calls[0]![0])).toBe(`${url.origin}/__boxd/ready`);
    // Ready once per computer.
    await provider.connectScreen(computer, { view: "stream", interactive: false }, ctx);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("suspends on stop, and treats a repeated stop or destroy of a deleted machine as done", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);

    await provider.stop(computer);
    expect(boxd.machine(computer.providerRef).status).toBe("suspended");
    expect(await provider.isStopped(computer)).toBe(true);
    await provider.destroy(computer, ctx);
    await expect(provider.stop(computer)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    expect(await provider.isRunning(computer)).toBe(false);
  });

  it("turns a boxd rate limit into the sandbox rate-limit error", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    boxd.failures.set("create", [new RateLimitError("too many machines", 8)]);

    await expect(
      provider.provision({ botId: "bot", homePath: "/unused" }, ctx),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
  });

  it("refuses a workspace export over its limits before reading any file", async () => {
    const boxd = new FakeBoxd();
    const provider = fakeBoxdProvider(boxd);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const content = new TextEncoder().encode("12345");
    for (const name of ["a.txt", "b.txt", ".browser-profiles/bot/Cache/data_1"]) {
      await provider.writeFile(computer, { path: name, content }, ctx);
    }
    const drain = async (limits: { maxBytes: number; maxFiles: number }) => {
      for await (const _ of provider.exportWorkspace(computer, ctx, limits));
    };

    await expect(drain({ maxBytes: 1_000, maxFiles: 1 })).rejects.toEqual(
      new WorkspaceTooLargeError("files"),
    );
    await expect(drain({ maxBytes: 9, maxFiles: 10 })).rejects.toEqual(
      new WorkspaceTooLargeError("bytes"),
    );
    const reads = boxd.calls.filter((call) => call === "fs.read").length;
    expect(reads).toBe(0);
    // The skipped browser cache does not count toward the limits.
    await expect(drain({ maxBytes: 10, maxFiles: 2 })).resolves.toBeUndefined();
  });

  it("does not rebuild a snapshot that is already ready", async () => {
    const boxd = new FakeBoxd();
    boxd.snapshots.set(BOXD_COMPUTER_SNAPSHOT, "ready");
    const provider = new BoxdSandboxProvider({}, boxd.client());

    expect(await provider.buildComputerSnapshot()).toEqual({
      name: BOXD_COMPUTER_SNAPSHOT,
      built: false,
    });
    expect(boxd.calls).not.toContain("create");
  });

  describe("a machine no computer points at", () => {
    const lostReply = new Error("reply lost");
    /** boxd creates the machine, and the reply never arrives. */
    function providerLosingCreateReply(
      boxd: FakeBoxd,
      remove?: BoxdSandboxClient["machines"]["delete"],
    ) {
      boxd.snapshots.set(BOXD_COMPUTER_SNAPSHOT, "ready");
      const client = boxd.client();
      if (remove) client.machines.delete = remove;
      const { create } = client.machines;
      client.machines.create = (async (params: Parameters<typeof create>[0]) => {
        await create(params);
        throw lostReply;
      }) as typeof create;
      return new BoxdSandboxProvider({}, client);
    }
    const provision = (provider: BoxdSandboxProvider, context: AdapterContext = ctx) =>
      settleMachineCleanup(() =>
        provider.provision({ botId: "bot", homePath: "/unused" }, context),
      );

    it("deletes the machine a lost create reply hid, trying a failed delete again", async () => {
      const boxd = new FakeBoxd();
      boxd.failures.set("delete", [new Error("connection reset")]);

      const { error, left } = await provision(providerLosingCreateReply(boxd));

      expect(error).toBe(lostReply);
      expect(boxd.machines.size).toBe(0);
      expect(left).toEqual([]);
    });

    it("reports the machine a lost create reply hid when it cannot be deleted", async () => {
      const boxd = new FakeBoxd();
      boxd.failures.set(
        "delete",
        Array.from({ length: 4 }, () => new Error("connection reset")),
      );

      const { error, left } = await provision(providerLosingCreateReply(boxd));

      expect(error).toBe(lostReply);
      const [machine] = [...boxd.machines.values()];
      expect(left).toEqual([{ provider: "boxd", machineId: machine!.name }]);
    });

    it("stops waiting after 20 seconds for a delete boxd never answers, and reports the machine", async () => {
      const boxd = new FakeBoxd();
      let startedAt = 0;
      let endedAt = 0;
      const remove = vi.fn(() => {
        startedAt ||= Date.now();
        return new Promise<void>(() => {});
      });

      const { error, left } = await settleMachineCleanup(() =>
        providerLosingCreateReply(boxd, remove)
          .provision({ botId: "bot", homePath: "/unused" }, ctx)
          .finally(() => {
            endedAt = Date.now();
          }),
      );

      expect(error).toBe(lostReply);
      expect(endedAt - startedAt).toBe(20_000);
      expect(remove).toHaveBeenCalledTimes(2);
      const [machine] = [...boxd.machines.values()];
      expect(left).toEqual([{ provider: "boxd", machineId: machine!.name }]);
    });

    it("deletes nothing after boxd refuses a create", async () => {
      const boxd = new FakeBoxd();
      boxd.failures.set("create", [new RateLimitError("too many machines", 8)]);

      const { error, left } = await provision(fakeBoxdProvider(boxd));

      expect(error).toBeInstanceOf(SandboxRateLimitError);
      expect(boxd.calls).not.toContain("delete");
      expect(left).toEqual([]);
    });

    it("keeps the cancellation as the error when a start cancelled during create cannot delete its machine", async () => {
      const cancelled = new Error("run cancelled");
      const start = async (deleteFailures: number) => {
        const boxd = new FakeBoxd();
        boxd.snapshots.set(BOXD_COMPUTER_SNAPSHOT, "ready");
        boxd.failures.set(
          "delete",
          Array.from({ length: deleteFailures }, () => new Error("connection reset")),
        );
        const controller = new AbortController();
        const client = boxd.client();
        const { create } = client.machines;
        client.machines.create = (async (params: Parameters<typeof create>[0]) => {
          const machine = await create(params);
          controller.abort(cancelled);
          return machine;
        }) as typeof create;
        const outcome = await provision(new BoxdSandboxProvider({}, client), {
          ...ctx,
          signal: controller.signal,
        });
        return { ...outcome, machines: [...boxd.machines.keys()] };
      };

      expect(await start(1)).toEqual({ error: cancelled, left: [], machines: [] });
      expect(await start(4)).toEqual({
        error: cancelled,
        left: [{ provider: "boxd", machineId: "machine-1" }],
        machines: ["machine-1"],
      });
    });

    it("deletes the snapshot build machine, trying a failed delete again", async () => {
      const boxd = new FakeBoxd();
      boxd.failures.set("delete", [new Error("connection reset")]);
      const provider = new BoxdSandboxProvider({}, boxd.client());

      const { error, left } = await settleMachineCleanup(() => provider.buildComputerSnapshot());

      expect(error).toBeUndefined();
      expect(boxd.snapshots.get(BOXD_COMPUTER_SNAPSHOT)).toBe("ready");
      expect(boxd.machines.size).toBe(0);
      expect(left).toEqual([]);
    });

    it("reports a snapshot build machine it cannot delete and keeps the build's own error", async () => {
      const boxd = new FakeBoxd();
      const refused = new Error("snapshot refused");
      boxd.failures.set("snapshots.create", [refused]);
      boxd.failures.set(
        "delete",
        Array.from({ length: 4 }, () => new Error("connection reset")),
      );
      const provider = new BoxdSandboxProvider({}, boxd.client());

      const { error, left } = await settleMachineCleanup(() => provider.buildComputerSnapshot());

      expect(error).toBe(refused);
      expect(left).toEqual([{ provider: "boxd", machineId: "machine-1" }]);
    });
  });
});
