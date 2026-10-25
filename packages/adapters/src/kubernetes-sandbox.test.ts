import type { Exec, V1Pod } from "@kubernetes/client-node";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { KubernetesSandboxSdk } from "./kubernetes-sandbox.js";
import { encodeTarEntry, KubernetesSandboxProvider, TarReader } from "./kubernetes-sandbox.js";

vi.mock("./computer-workspace.js", () => ({
  shouldSkipPortableWorkspaceFile: (file: string) => file.includes(".browser-profiles/Cache/"),
}));

const TAR_END = Buffer.alloc(1024);

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const readyPod: V1Pod = {
  metadata: { name: "pod", labels: { "rakazo-bot-id": "bot-a" } },
  status: {
    phase: "Running",
    podIP: "10.0.0.8",
    conditions: [{ type: "Ready", status: "True" }],
  },
};

function providerFor(
  core: Partial<KubernetesSandboxSdk["core"]> = {},
  exec: KubernetesSandboxSdk["exec"]["exec"] = vi.fn(),
  options: ConstructorParameters<typeof KubernetesSandboxProvider>[0] = {},
) {
  return new KubernetesSandboxProvider(options, {
    core: {
      readNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      createNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      deleteNamespacedPod: vi.fn().mockResolvedValue({ status: "Success" }),
      ...core,
    },
    exec: { exec },
  } as unknown as KubernetesSandboxSdk);
}

const computer: ComputerRef = {
  id: "pod",
  botId: "bot-a",
  kind: "kubernetes",
  providerRef: "pod",
};

function successfulExec(stdoutText = "", stderrText = "", code = 0) {
  return vi.fn(async (...args: Parameters<Exec["exec"]>) => {
    const stdout = args[4];
    const stderr = args[5];
    const status = args[8];
    queueMicrotask(() => {
      if (stdoutText) stdout?.write(Buffer.from(stdoutText));
      if (stderrText) stderr?.write(Buffer.from(stderrText));
      status?.({
        status: code === 0 ? "Success" : "Failure",
        details: { causes: [{ reason: "ExitCode", message: String(code) }] },
      });
    });
    return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
      ReturnType<Exec["exec"]>
    >;
  });
}

describe("KubernetesSandboxProvider", () => {
  it("validates the immutable computer image without package installation", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);

    await provider.prepare(computer, context);

    const command = exec.mock.calls[0]?.[3];
    expect(command).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "300s",
      "bash",
      "-c",
      expect.any(String),
    ]);
    const script = command?.[6] ?? "";
    expect(script).not.toContain("sudo");
    expect(script).not.toContain("apt-get");
    expect(script).toContain("command -v scrot");
    expect(script).toContain("command -v import");
    expect(script).toContain("computer image is missing required desktop tools");
  });

  it("creates a ready pod with required isolation metadata", async () => {
    const readNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const createNamespacedPod = vi.fn().mockResolvedValue(readyPod);
    const deleteNamespacedPod = vi.fn().mockResolvedValue({ status: "Success" });
    const provider = new KubernetesSandboxProvider(
      {
        namespace: "sandboxes",
        runtimeClassName: "gvisor",
        computerImage: "registry.example.test/computer:v1",
        cpuLimit: "2",
        memoryLimit: "4Gi",
        podAnnotations: { "example.test/policy": "sandbox" },
        podLabels: { "example.test/tier": "computer" },
      },
      {
        core: { readNamespacedPod, createNamespacedPod, deleteNamespacedPod },
        exec: { exec: vi.fn() },
      } as unknown as KubernetesSandboxSdk,
    );

    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({ kind: "kubernetes", botId: "bot-a", fresh: true });
    expect(createNamespacedPod).toHaveBeenCalledOnce();
    const request = createNamespacedPod.mock.calls[0]?.[0];
    expect(request?.namespace).toBe("sandboxes");
    expect(request?.body).toMatchObject({
      metadata: {
        annotations: { "example.test/policy": "sandbox" },
        labels: {
          "app.kubernetes.io/name": "rakazo-computer",
          "example.test/tier": "computer",
          "rakazo-bot-id": "bot-a",
        },
      },
      spec: {
        automountServiceAccountToken: false,
        runtimeClassName: "gvisor",
        containers: [
          {
            image: "registry.example.test/computer:v1",
            resources: { limits: { cpu: "2", memory: "4Gi" } },
          },
        ],
      },
    });
    await expect(provider.isRunning(computer, context)).resolves.toBe(true);
    await provider.destroy(computer, context);
    expect(deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: computer.providerRef, namespace: "sandboxes" }),
    );
  });

  it("streams stdout and stderr and preserves the remote exit code", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdout = args[4];
      const stderr = args[5];
      const status = args[8];
      queueMicrotask(() => {
        stdout?.write(Buffer.from("out"));
        stderr?.write(Buffer.from("err"));
        status?.({
          status: "Failure",
          details: { causes: [{ reason: "ExitCode", message: "7" }] },
        });
      });
      return {
        close: vi.fn(),
        onclose: null,
        onerror: null,
      } as unknown as Awaited<ReturnType<Exec["exec"]>>;
    });
    const provider = new KubernetesSandboxProvider(
      {},
      {
        core: {} as KubernetesSandboxSdk["core"],
        exec: { exec },
      },
    );
    const computer: ComputerRef = {
      id: "pod",
      botId: "bot-a",
      kind: "kubernetes",
      providerRef: "pod",
    };
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      computer,
      { argv: ["printf", "done"], env: { TEST_VALUE: "value" }, unsetEnv: ["OLD_VALUE"] },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    expect(exec).toHaveBeenCalledWith(
      "rakazo-sandboxes",
      "pod",
      "computer",
      expect.arrayContaining(["TEST_VALUE=value", "OLD_VALUE", "printf", "done"]),
      expect.anything(),
      expect.anything(),
      null,
      false,
      expect.any(Function),
    );
  });

  it("attaches the controlled terminal without replacing the bot run screen fence", async () => {
    const exec = successfulExec("RAKAZO_DESKTOP=0:view-token\n");
    const provider = providerFor({}, exec);

    await provider.connectTerminal(
      computer,
      { controlToken: "control-token", cwd: "" },
      { ...context, botId: "bot-a", screenLeaseId: "run-id:7" },
    );

    const commands = exec.mock.calls
      .map((call) => (Array.isArray(call[3]) ? call[3].join(" ") : call[3]))
      .join("\n");
    expect(commands).toContain("control-token");
    expect(commands).not.toContain("run-id:7");
  });

  it("reconnects to an existing ready pod without creating it", async () => {
    const create = vi.fn();
    const provider = providerFor({
      readNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      createNamespacedPod: create,
    });
    const result = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(result.fresh).toBe(false);
    expect(result.providerRef).toMatch(/^rakazo-bot-a-/);
    expect(create).not.toHaveBeenCalled();
  });

  it("handles a create conflict by reconnecting to the matching pod", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { code: 409 }));
    const provider = providerFor({ readNamespacedPod: read, createNamespacedPod: create });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ fresh: false });
  });

  it("rejects a create conflict when the winner belongs to another bot", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue({ ...readyPod, metadata: { labels: { "rakazo-bot-id": "bot-b" } } });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { code: 409 }));
    const provider = providerFor({ readNamespacedPod: read, createNamespacedPod: create });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("belongs to another bot");
  });

  it("rejects a pod carrying another bot's label", async () => {
    const provider = providerFor({
      readNamespacedPod: vi
        .fn()
        .mockResolvedValue({ ...readyPod, metadata: { labels: { "rakazo-bot-id": "bot-b" } } }),
    });
    await expect(
      provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      ),
    ).rejects.toThrow("belongs to another bot");
  });

  it.each(["Failed", "Succeeded"])(
    "deletes terminal %s pods before provisioning",
    async (phase) => {
      const terminal = { ...readyPod, status: { phase } } as V1Pod;
      const read = vi
        .fn()
        .mockResolvedValueOnce(terminal)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(readyPod);
      const del = vi.fn().mockResolvedValue({ status: "Success" });
      const create = vi.fn().mockResolvedValue(readyPod);
      const provider = providerFor({
        readNamespacedPod: read,
        deleteNamespacedPod: del,
        createNamespacedPod: create,
      });
      await provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      );
      expect(del).toHaveBeenCalledWith(expect.objectContaining({ gracePeriodSeconds: 0 }));
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it("times out readiness and deletes a newly created pod", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue({ ...readyPod, status: { phase: "Pending" } });
    const del = vi.fn().mockResolvedValue({ status: "Success" });
    const provider = providerFor({ readNamespacedPod: read, deleteNamespacedPod: del }, vi.fn(), {
      readyTimeoutMs: 1,
    });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("did not become ready");
    expect(del).toHaveBeenCalledOnce();
  });

  it("rejects when a pod disappears while waiting for readiness", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockRejectedValue(Object.assign(new Error("gone"), { code: 404 }));
    const del = vi.fn();
    const provider = providerFor({ readNamespacedPod: read, deleteNamespacedPod: del });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("disappeared while starting");
    expect(del).toHaveBeenCalledOnce();
  });

  it("uses the requested pod security and lifecycle fields", async () => {
    const create = vi.fn().mockResolvedValue(readyPod);
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const provider = providerFor({ createNamespacedPod: create, readNamespacedPod: read });
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(create.mock.calls[0]?.[0].body?.spec).toMatchObject({
      automountServiceAccountToken: false,
      restartPolicy: "Never",
    });
  });

  it("parses split UTF-8 output and preserves separate streams", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const out = args[4];
      const err = args[5];
      const status = args[8];
      queueMicrotask(() => {
        out?.write(Buffer.from([0xe2]));
        err?.write(Buffer.from("err-"));
        out?.write(Buffer.from([0x82, 0xac]));
        err?.write(Buffer.from("tail"));
        status?.({ status: "Success" });
      });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const events = [];
    for await (const event of providerFor({}, exec).execute(computer, { argv: ["true"] }, context))
      events.push(event);
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => event.data)
        .join(""),
    ).toBe("€");
    expect(
      events
        .filter((event) => event.type === "stderr")
        .map((event) => event.data)
        .join(""),
    ).toBe("err-tail");
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
  });

  it("falls back to exit code 1 when Kubernetes omits an exit code", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      queueMicrotask(() => args[8]?.({ status: "Failure" }));
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const events = [];
    for await (const event of providerFor({}, exec).execute(computer, { argv: ["false"] }, context))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("preserves the timeout command's 124 exit fallback", async () => {
    const events = [];
    for await (const event of providerFor({}, successfulExec("", "timed out", 124)).execute(
      computer,
      { argv: ["sleep", "10"], timeoutMs: 1_000 },
      context,
    ))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
  });

  it("rejects Kubernetes exec socket errors", async () => {
    const exec = vi.fn(async () => {
      const socket = {
        close: vi.fn(),
        onclose: null as (() => void) | null,
        onerror: null as ((event: { error: Error }) => void) | null,
      };
      setTimeout(() => socket.onerror?.({ error: new Error("socket broke") }), 0);
      return socket as unknown as Awaited<ReturnType<Exec["exec"]>>;
    });
    const iterator = providerFor({}, exec)
      .execute(computer, { argv: ["true"] }, context)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("socket broke");
  });

  it("cancels immediately with stderr and exit code 130", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of providerFor().execute(
      computer,
      { argv: ["sleep", "10"] },
      { ...context, signal: controller.signal },
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stderr", data: "command aborted\n" },
      { type: "exit", code: 130 },
    ]);
  });

  it("normalizes working directories, validates env names, and wraps timeouts", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);
    for await (const _event of provider.execute(
      computer,
      { argv: ["printf", "x"], cwd: "nested/dir", env: { OK_1: "yes" }, timeoutMs: 2_000 },
      context,
    )) {
      /* consume */
    }
    const command = exec.mock.calls[0]?.[3];
    expect(command).toContain("/home/rakazo/nested/dir");
    expect(command).toContain("OK_1=yes");
    expect(command).toContain("2s");
    const invalid = provider
      .execute(computer, { argv: ["true"], env: { "BAD-NAME": "no" } }, context)
      [Symbol.asyncIterator]();
    await expect(invalid.next()).rejects.toThrow("invalid environment name");
  });

  it("passes TTY mode and leaves stderr detached", async () => {
    const exec = successfulExec("terminal");
    const events = [];
    for await (const event of providerFor({}, exec).execute(
      computer,
      { argv: ["tty"], pty: true },
      context,
    ))
      events.push(event);
    expect(exec.mock.calls[0]?.[5]).toBeNull();
    expect(exec.mock.calls[0]?.[7]).toBe(true);
    expect(events).toContainEqual({ type: "stdout", data: "terminal" });
    expect(events.some((event) => event.type === "stderr")).toBe(false);
  });

  it("lists files with kinds, executable flags, and sorting", async () => {
    const exec = successfulExec(
      ["z", "f", "2", "644", "folder", "d", "0", "755", "a", "f", "1", "755", ""].join("\0"),
    );
    const result = await providerFor({}, exec).listFiles(computer, "", context);
    expect(result.map(({ path, kind, executable }) => ({ path, kind, executable }))).toEqual([
      { path: "a", kind: "file", executable: true },
      { path: "folder", kind: "dir", executable: undefined },
      { path: "z", kind: "file", executable: undefined },
    ]);
  });

  it("rejects list errors", async () => {
    await expect(
      providerFor({}, successfulExec("", "find failed", 2)).listFiles(computer, "", context),
    ).rejects.toThrow("find failed");
  });

  it("checks file size before cat and streams file contents", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const command = args[3];
      const out = args[4];
      const status = args[8];
      queueMicrotask(() => {
        out?.write(command.includes("stat") ? "3" : "abc");
        status?.({ status: "Success" });
      });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const provider = providerFor({}, exec);
    await expect(provider.readFile(computer, "f", context, { maxBytes: 2 })).rejects.toThrow(
      "exceeds 2 bytes",
    );
    expect(exec).toHaveBeenCalledOnce();
    await expect(provider.readFile(computer, "f", context)).resolves.toEqual(
      new Uint8Array(Buffer.from("abc")),
    );
  });

  it("writes files atomically with executable and regular permissions", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: Buffer.from("x"), executable: true },
      context,
    );
    expect(String(exec.mock.calls[0]?.[3])).toContain('mv -f -- "$temporary" "$target"');
    expect(String(exec.mock.calls[0]?.[3])).toContain("700");
    await provider.writeFile(computer, { path: "data", content: Buffer.from("x") }, context);
    expect(String(exec.mock.calls[1]?.[3])).toContain("600");
  });

  it("propagates write failures", async () => {
    await expect(
      providerFor({}, successfulExec("", "write denied", 1)).writeFile(
        computer,
        { path: "data", content: Buffer.from("x") },
        context,
      ),
    ).rejects.toThrow("write denied");
  });

  it("exports binary files without attaching stdin to the archive exec", async () => {
    const binary = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const staged: Buffer[] = [];
    const commands: string[][] = [];
    const archive = Buffer.concat([
      ...encodeTarEntry("a.txt", binary),
      ...encodeTarEntry("run.sh", Buffer.from("#!"), true),
      TAR_END,
    ]);
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const command = args[3];
      if (!Array.isArray(command)) throw new Error("expected argv");
      commands.push(command);
      if (args[6]) {
        args[6].on("data", (chunk: Buffer) => staged.push(Buffer.from(chunk)));
        args[6].on("end", () => args[8]?.({ status: "Success" }));
      } else
        queueMicrotask(() => {
          if (command.includes("find")) {
            args[4]?.write(["a.txt", ".browser-profiles/Cache/blob", "run.sh", ""].join("\0"));
          } else if (command.includes("tar")) {
            expect(args[6]).toBeNull();
            args[4]?.write(archive.subarray(0, 700));
            args[4]?.write(archive.subarray(700));
          }
          args[8]?.({ status: "Success" });
        });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const files = [];
    for await (const file of providerFor({}, exec).exportWorkspace(computer, context))
      files.push(file);
    expect(commands[0]?.join(" ")).toContain("Browser.close");
    expect(commands.filter((command) => command.includes("tar"))).toHaveLength(1);
    expect(Buffer.concat(staged).toString()).toBe("a.txt\0run.sh\0");
    expect(commands.at(-1)?.slice(0, 4)).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "10s",
    ]);
    expect(commands.at(-1)).toContain("rm");
    expect(files).toEqual([
      { path: "a.txt", content: new Uint8Array(binary) },
      { path: "run.sh", content: new Uint8Array(Buffer.from("#!")), executable: true },
    ]);
  });

  it("imports every file through one tar exec", async () => {
    const stdinChunks: Buffer[] = [];
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdin = args[6];
      if (stdin) {
        stdin.on("data", (data: Buffer) => stdinChunks.push(Buffer.from(data)));
        stdin.on("end", () => args[8]?.({ status: "Success" }));
      } else {
        queueMicrotask(() => args[8]?.({ status: "Success" }));
      }
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    async function* files() {
      yield { path: "one", content: Buffer.from("1") };
      yield { path: `${"d/".repeat(60)}two`, content: Buffer.from("2"), executable: true };
    }
    await providerFor({}, exec).importWorkspace(computer, files(), context);
    const tarCalls = exec.mock.calls.filter((call) => (call[3] as string[]).includes("tar"));
    expect(tarCalls).toHaveLength(1);
    const reader = new TarReader(1024);
    const read = reader.push(Buffer.concat(stdinChunks));
    expect(read.map((file) => [file.path, file.executable])).toEqual([
      ["one", undefined],
      [`${"d/".repeat(60)}two`, true],
    ]);
  });

  it("stops importing on cancellation", async () => {
    const controller = new AbortController();
    async function* files() {
      yield { path: "one", content: Buffer.from("1") };
      controller.abort();
      yield { path: "two", content: Buffer.from("2") };
    }
    const consuming = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdin = args[6];
      if (stdin) stdin.on("data", () => undefined);
      else queueMicrotask(() => args[8]?.({ status: "Success" }));
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    await expect(
      providerFor({}, consuming).importWorkspace(computer, files(), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("formats screen URLs for IPv4 and IPv6 and rejects missing IP", async () => {
    const screenPod = (podIP?: string) => ({ ...readyPod, status: { ...readyPod.status, podIP } });
    for (const [ip, host] of [
      ["10.0.0.8", "10.0.0.8"],
      ["2001:db8::1", "[2001:db8::1]"],
    ] as const) {
      const exec = successfulExec("RAKAZO_DESKTOP=0:token");
      const provider = providerFor(
        { readNamespacedPod: vi.fn().mockResolvedValue(screenPod(ip)) },
        exec,
      );
      await expect(
        provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      ).resolves.toMatchObject({
        url: expect.stringContaining(`http://${host}:`),
      });
      // vnc.html reads localStorage, which the sandboxed frame forbids.
      await expect(
        provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      ).resolves.toMatchObject({ url: expect.stringContaining("/embed.html") });
      const commands = exec.mock.calls.map((call) => (call[3] as string[]).join(" ")).join("\n");
      expect(commands).toContain("0.0.0.0:6100");
    }
    await expect(
      providerFor(
        { readNamespacedPod: vi.fn().mockResolvedValue(screenPod(undefined)) },
        successfulExec("RAKAZO_DESKTOP=0:token"),
      ).connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("no pod IP");
  });

  it("reports running only for Kubernetes computers in Running phase", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(readyPod)
      .mockResolvedValueOnce({ ...readyPod, status: { phase: "Pending" } });
    const provider = providerFor({ readNamespacedPod: read });
    await expect(provider.isRunning(computer, context)).resolves.toBe(true);
    await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    await expect(provider.isRunning({ ...computer, kind: "docker" }, context)).resolves.toBe(false);
  });

  it.each(["stop", "destroy"] as const)(
    "%s deletes immediately and ignores 404",
    async (method) => {
      const del = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: 404 }));
      const provider = providerFor({ deleteNamespacedPod: del });
      await expect(provider[method](computer, context)).resolves.toBeUndefined();
      expect(del).toHaveBeenCalledWith(
        expect.objectContaining({ gracePeriodSeconds: 0, name: "pod" }),
      );
    },
  );

  it("describes contract and capabilities", () => {
    expect(providerFor().describe()).toMatchObject({
      contractVersion: "1",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: false,
        multiScreen: true,
      },
    });
  });
});
