import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  MachineRecords,
  settleMachineCleanup,
} from "../../../computers/sandbox/sandbox-test-support.js";
import { BOOT_SCRIPT, EXEC_WRAPPER } from "./exe-boot.js";
import { FakeExe, providerFor, vm } from "./exe-sandbox.test-support.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "rakazo-box",
  botId: "bot-a",
  kind: "exe",
  providerRef: "rakazo-box",
};

async function collect(events: AsyncIterable<ProcessEvent>) {
  const collected: ProcessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function fakeWith(...vms: ReturnType<typeof vm>[]) {
  const fake = new FakeExe();
  for (const entry of vms) fake.vms.set(entry.name, entry);
  return fake;
}

describe("ExeSandboxProvider", () => {
  it("creates a tagged standalone VM from the computer image and boots it", async () => {
    const fake = new FakeExe();
    const provider = providerFor(fake, {
      tag: "rakazo-computers",
      computerImage: "ghcr.io/elie222/rakazo/computer:v1",
      cpus: 4,
      memory: "8GB",
    });

    const created = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(created).toMatchObject({ kind: "exe", botId: "bot-a", fresh: true });
    expect(created.providerRef).toMatch(/^rakazo-[0-9a-f]{16}$/);
    const made = fake.vms.get(created.providerRef!)!;
    expect(made.created).toEqual({
      name: created.providerRef,
      image: "ghcr.io/elie222/rakazo/computer:v1",
      tag: "rakazo-computers",
      comment: "rakazo computer for bot bot-a",
      cpus: 4,
      memory: "8GB",
    });
    expect(made.boots).toBe(1);
    // Every command after the boot reaches the image user through the wrapper.
    const after = fake.runs.filter((run) => run.command[0] === EXEC_WRAPPER);
    expect(after.length).toBeGreaterThan(0);
    expect(fake.runs[0]?.input?.toString()).toBe(BOOT_SCRIPT);
    expect(fake.runs[0]?.command).toEqual([
      expect.stringMatching(/^RAKAZO_EXTRA_ENV=.*VNC_RESOLUTION=1280x800/s),
      "bash",
      "-s",
    ]);
  });

  it("boots the image as the image user without new privileges", () => {
    expect(BOOT_SCRIPT).toContain("setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs");
    // The image's TERM handler would signal every process when run as root.
    expect(BOOT_SCRIPT).toContain('kill -KILL "$pid"');
    expect(BOOT_SCRIPT).not.toMatch(/kill -TERM/);
  });

  it("waits for the image's desktop gateway before returning", async () => {
    let probes = 0;
    const fake = new FakeExe((command) => {
      if (command.some((arg) => arg.includes("/dev/tcp/127.0.0.1/6080"))) {
        probes += 1;
        return { code: probes < 3 ? 1 : 0 };
      }
      return {};
    });
    await providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(probes).toBe(3);
  });

  it("reconnects to a running VM of the same bot and boots it again", async () => {
    const fake = fakeWith(vm("rakazo-box"));
    const found = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "exe", providerRef: "rakazo-box" },
      context,
    );
    expect(found).toMatchObject({ providerRef: "rakazo-box", fresh: false });
    expect(fake.vms.size).toBe(1);
    // The boot script returns at once on a VM it already booted; one that restarted needs it.
    expect(fake.vms.get("rakazo-box")?.boots).toBe(1);
  });

  it("never reuses or deletes another bot's VM", async () => {
    const fake = fakeWith(vm("rakazo-box", "bot-b"));
    const provider = providerFor(fake);
    await expect(
      provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "exe", providerRef: "rakazo-box" },
        context,
      ),
    ).rejects.toThrow("belongs to another bot");
    await expect(provider.destroy(computer, context)).rejects.toThrow("belongs to another bot");
    expect(fake.vms.has("rakazo-box")).toBe(true);
  });

  it("does not take a VM with the bot's comment but another tag", async () => {
    const fake = fakeWith(vm("rakazo-box", "bot-a", ["someone-else"]));
    await expect(providerFor(fake, { tag: "rakazo" }).destroy(computer, context)).rejects.toThrow(
      "belongs to another bot",
    );
  });

  it("works without a tag, and a tag-scoped key's tag does not get in the way", async () => {
    const fake = new FakeExe();
    fake.keyTag = "team-computers";
    const provider = providerFor(fake);
    const created = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fake.vms.get(created.providerRef!)?.created?.tag).toBeUndefined();
    expect(fake.vms.get(created.providerRef!)?.tags).toEqual(["team-computers"]);
    const found = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerKind: "exe",
        providerRef: created.providerRef,
      },
      context,
    );
    expect(found).toMatchObject({ providerRef: created.providerRef, fresh: false });
  });

  it("never takes a VM that it did not name", async () => {
    const fake = fakeWith({ ...vm("my-desktop"), tags: [] });
    const created = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    expect([...fake.vms.keys()].sort()).toEqual([created.providerRef, "my-desktop"].sort());
  });

  it("ignores a stored reference from another provider", async () => {
    const fake = fakeWith(vm("rakazo-box"));
    const created = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "incus", providerRef: "rakazo-box" },
      context,
    );
    expect(created.providerRef).not.toBe("rakazo-box");
  });

  it("replaces a stored VM that is no longer running", async () => {
    const fake = fakeWith(vm("rakazo-box", "bot-a", ["rakazo"], "stopped"));
    const created = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "exe", providerRef: "rakazo-box" },
      context,
    );
    expect(created.fresh).toBe(true);
    expect([...fake.vms.keys()]).toEqual([created.providerRef]);
  });

  it("removes this bot's VMs that no saved reference points to before starting", async () => {
    const fake = fakeWith(
      vm("rakazo-old"),
      vm("rakazo-kept"),
      vm("rakazo-other", "bot-b"),
      vm("rakazo-foreign", "bot-a", ["x"]),
    );
    fake.vms.get("rakazo-kept")!.status = "stopped";
    const created = await providerFor(fake, { tag: "rakazo" }).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "exe", providerRef: "rakazo-kept" },
      context,
    );
    expect([...fake.vms.keys()].sort()).toEqual(
      [created.providerRef, "rakazo-foreign", "rakazo-other"].sort(),
    );
  });

  it("still starts when listing earlier VMs fails", async () => {
    const fake = new FakeExe();
    fake.onCall = (call) => {
      if (call === "ls") throw new Error("exe.dev ls: unavailable");
    };
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ fresh: true });
  });

  it("records a new VM's name before asking exe.dev to create it", async () => {
    const fake = new FakeExe();
    const records = new MachineRecords();
    let whenAsked: ReturnType<MachineRecords["dueIn"]> | undefined;
    fake.onCall = (call) => {
      if (call.startsWith("new ")) whenAsked ??= records.dueIn();
    };
    const created = await providerFor(fake, { unreferencedMachines: records }).provision(
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    expect(whenAsked).toMatchObject([
      { provider: "exe", machineId: created.providerRef, homeKey: "bot-a" },
    ]);
  });

  it("deletes a new VM that fails to boot", async () => {
    const fake = new FakeExe();
    fake.failBoot = "the computer image's command is not running";
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("the computer image's command is not running");
    expect(fake.vms.size).toBe(0);
  });

  it("removes a new VM that does not become ready", async () => {
    const fake = new FakeExe((command) =>
      command.some((arg) => arg.includes("/dev/tcp")) ? { code: 1 } : {},
    );
    await expect(
      providerFor(fake, { readyTimeoutMs: 1 }).provision(
        { botId: "bot-a", homePath: "/unused" },
        context,
      ),
    ).rejects.toMatchObject({ name: "SandboxUnavailableError" });
    expect(fake.vms.size).toBe(0);
  });

  it("hands a new VM it could not remove to the records", async () => {
    const fake = new FakeExe((command) =>
      command.some((arg) => arg.includes("/dev/tcp")) ? { code: 1 } : {},
    );
    fake.onCall = (call) => {
      if (call.startsWith("rm ")) throw new Error("exe.dev rm: busy");
    };
    const records = new MachineRecords();
    let endedAt = 0;
    await settleMachineCleanup(() =>
      providerFor(fake, { readyTimeoutMs: 1, unreferencedMachines: records })
        .provision({ botId: "bot-a", homePath: "/unused" }, context)
        .finally(() => {
          endedAt = Date.now();
        }),
    );
    expect(records.dueIn(endedAt)).toEqual([
      { provider: "exe", machineId: [...fake.vms.keys()][0], homeKey: "bot-a", dueInMs: 0 },
    ]);
  });

  it("deletes the VM on stop and counts one already gone as removed", async () => {
    const fake = fakeWith(vm("rakazo-box"));
    const provider = providerFor(fake);
    await provider.stop(computer, context);
    expect(fake.vms.size).toBe(0);
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(
      provider.deleteMachine(
        { provider: "exe", machineId: "rakazo-box" },
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toBeUndefined();
  });

  it("reports whether the VM runs", async () => {
    const fake = fakeWith(vm("rakazo-box"));
    const provider = providerFor(fake);
    expect(await provider.isRunning(computer, context)).toBe(true);
    fake.vms.get("rakazo-box")!.status = "stopped";
    expect(await provider.isRunning(computer, context)).toBe(false);
    fake.vms.clear();
    expect(await provider.isRunning(computer, context)).toBe(false);
  });

  it("streams stdout and stderr separately and keeps the exit code", async () => {
    const fake = new FakeExe(() => ({ stdout: "out", stderr: "err", code: 7 }));
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    const events = await collect(
      providerFor(fake).execute(
        computer,
        { argv: ["printf", "done"], env: { TEST_VALUE: "value" }, cwd: "nested" },
        context,
      ),
    );
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    const run = fake.runs[0]!;
    expect(run.name).toBe("rakazo-box");
    expect(run.command[0]).toBe(EXEC_WRAPPER);
    expect(run.command).toEqual(
      expect.arrayContaining(["/home/rakazo/nested", "TEST_VALUE=value", "printf", "done"]),
    );
    expect(run.input).toBeUndefined();
  });

  it("sends a file's content as the command's input", async () => {
    const fake = new FakeExe();
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    await providerFor(fake).writeFile(
      computer,
      { path: "notes/today.txt", content: Buffer.from("hello there") },
      context,
    );
    const write = fake.runs.find((run) => run.command.includes("rakazo-write"))!;
    expect(write.input?.toString()).toBe("hello there");
  });

  it("stops a cancelled command", async () => {
    const fake = new FakeExe(() => "hang");
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    const controller = new AbortController();
    const events = collect(
      providerFor(fake).execute(
        computer,
        { argv: ["sleep", "100"] },
        { ...context, signal: controller.signal },
      ),
    );
    await expect.poll(() => fake.runs.length).toBe(1);
    controller.abort();
    await events.catch(() => []);
    expect(fake.runs[0]?.aborted).toBe(true);
  });

  it("reports a command on a deleted VM as a gone computer", async () => {
    const fake = new FakeExe();
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    const provider = providerFor(fake);
    expect(await provider.isRunning(computer, context)).toBe(true);
    fake.vms.clear();
    await expect(
      collect(provider.execute(computer, { argv: ["true"] }, context)),
    ).rejects.toMatchObject({ name: "SandboxNotFoundError" });
  });

  it("does not report a failure on a running VM as a gone computer", async () => {
    const fake = new FakeExe();
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    const provider = providerFor(fake);
    fake.run = async () => {
      throw new Error("exe.dev API error (502) during ssh");
    };
    await expect(collect(provider.execute(computer, { argv: ["true"] }, context))).rejects.toThrow(
      "exe.dev API error (502)",
    );
  });

  it("serves screens through the VM's HTTPS proxy with a VM token", async () => {
    const fake = new FakeExe((command) =>
      command.some((arg) => arg.includes("RAKAZO_DESKTOP="))
        ? { stdout: "RAKAZO_DESKTOP=0:view-token\n" }
        : {},
    );
    fake.vms.set("rakazo-box", vm("rakazo-box"));
    const session = await providerFor(fake).connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(session.url).toMatch(/^https:\/\/rakazo-box\.exe\.xyz:\d+\/embed\.html/);
    expect(session.headers?.["X-Exedev-Authorization"]).toMatch(/^Bearer token:rakazo-box:\d+$/);
    const expiresAt = Number(session.headers!["X-Exedev-Authorization"]!.split(":").at(-1));
    // It outlives the hour the screen capability that carries it lasts.
    expect(expiresAt * 1000).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it("counts as billing while it runs", () => {
    expect(providerFor().billsWhileRunning()).toBe(true);
  });

  it("validates the tag", () => {
    expect(() => providerFor(new FakeExe(), { tag: "Bad Tag" })).toThrow("EXE_SANDBOX_TAG");
    expect(() => providerFor(new FakeExe(), { cpus: 1.5 })).toThrow("EXE_SANDBOX_CPUS");
  });

  it("describes contract and capabilities", () => {
    expect(providerFor().describe()).toMatchObject({
      id: "exe",
      contractVersion: "1",
      capabilities: { graphical: true, pty: true, takeover: true, persistentHome: false },
    });
  });
});
