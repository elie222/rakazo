import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  RateLimitError,
  SandboxNotFoundError,
  TimeoutError,
} from "novita-sandbox";
import { describe, expect, it, vi } from "vitest";
import { sandboxIdleMs } from "./computer-idle.js";
import { NovitaSandboxProvider } from "./novita-sandbox.js";
import { fakeNovita } from "./novita-sandbox.test-support.js";
import { NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract } from "./sandbox-test-support.js";

const ctx = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const request = { botId: "bot", homePath: "/unused" };

async function started() {
  const fake = fakeNovita();
  const computer = await fake.provider.provision(request, ctx);
  return { ...fake, computer, desktop: fake.machines.get(computer.id)!.desktop };
}

async function execute(
  provider: NovitaSandboxProvider,
  computer: Awaited<ReturnType<NovitaSandboxProvider["provision"]>>,
) {
  const events = [];
  for await (const event of provider.execute(computer, { argv: ["true"], timeoutMs: 42 }, ctx))
    events.push(event);
  return events;
}

describe("Novita computer backend", () => {
  it("has its own provider identity and uses an auto-pausing desktop template", async () => {
    const { provider, sdk, computer } = await started();
    expect(provider.describe()).toMatchObject({
      id: "novita",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    });
    expect(provider.billsWhileRunning()).toBe(true);
    expect(computer).toMatchObject({ kind: "novita", fresh: true });
    expect(sdk.create).toHaveBeenCalledWith(NOVITA_COMPUTER_TEMPLATE, {
      apiKey: "test-novita-key",
      timeoutMs: sandboxIdleMs(),
      metadata: { botId: "bot", rakazo: "computer" },
      resolution: [1280, 800],
      lifecycle: { onTimeout: "pause", autoResume: false },
    });
  });

  it("uses a configured template and never silently provisions the larger stock desktop", async () => {
    const { sdk } = fakeNovita();
    const missing = new Error("404: template not found");
    vi.mocked(sdk.create).mockRejectedValue(missing);
    const provider = new NovitaSandboxProvider(
      { apiKey: "test-key", template: "custom-desktop" },
      sdk,
    );
    await expect(provider.provision(request, ctx)).rejects.toBe(missing);
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(sdk.create).toHaveBeenCalledWith("custom-desktop", expect.anything());
  });

  it("passes the shared observation, action, binary file, and portable workspace contract", async () => {
    const { provider, computer } = await started();
    await assertSandboxWorkspaceContract(provider, computer, ctx);
    await provider.destroy(computer, ctx);
  });

  it("keeps separate computers independent and preserves files after pause and API restart", async () => {
    const { provider, sdk, computer, machines } = await started();
    const second = await provider.provision({ ...request, botId: "other" }, ctx);
    expect(second.id).not.toBe(computer.id);
    await provider.writeFile(
      computer,
      { path: "state", content: new TextEncoder().encode("saved") },
      ctx,
    );
    await expect(provider.readFile(second, "state", ctx)).rejects.toBeInstanceOf(FileNotFoundError);
    await provider.stop(computer, ctx);
    expect(machines.get(computer.id)!.paused).toBe(true);
    const restarted = new NovitaSandboxProvider({ apiKey: "test-key" }, sdk);
    const resumed = await restarted.provision(
      { ...request, providerRef: computer.providerRef, providerKind: "novita" },
      ctx,
    );
    expect(resumed).toMatchObject({ id: computer.id, kind: "novita", fresh: false });
    expect(new TextDecoder().decode(await restarted.readFile(resumed, "state", ctx))).toBe("saved");
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it("does not send another provider's stored reference to Novita", async () => {
    const { provider, sdk } = fakeNovita();
    await provider.provision({ ...request, providerRef: "e2b-id", providerKind: "e2b" }, ctx);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it.each([
    new AuthenticationError("Invalid API key"),
    new RateLimitError("429: quota exceeded"),
    new Error("fetch failed"),
  ])("preserves an existing computer on $name", async (error) => {
    const { provider, sdk } = fakeNovita();
    vi.mocked(sdk.connect).mockRejectedValue(error);
    await expect(
      provider.provision({ ...request, providerRef: "existing", providerKind: "novita" }, ctx),
    ).rejects.toBe(error);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("replaces a computer only after a native sandbox-not-found response", async () => {
    const { provider, sdk } = fakeNovita();
    await expect(
      provider.provision({ ...request, providerRef: "gone", providerKind: "novita" }, ctx),
    ).resolves.toMatchObject({ kind: "novita", fresh: true });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("recovers an idle-paused computer without replaying the failed command", async () => {
    const { provider, computer, machines, desktop, sdk } = await started();
    machines.get(computer.id)!.paused = true;
    await expect(execute(provider, computer)).rejects.toThrow("has been resumed; try again");
    expect(desktop.commands.run).toHaveBeenCalledOnce();
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.create).toHaveBeenCalledOnce();
    await expect(execute(provider, computer)).resolves.toEqual([{ type: "exit", code: 0 }]);
  });

  it("maps native command exits and deadlines without mistaking request timeouts for command exits", async () => {
    const { provider, computer, desktop } = await started();
    vi.mocked(desktop.commands.run).mockRejectedValueOnce(
      new CommandExitError({ exitCode: 7, stdout: "out", stderr: "err" }),
    );
    await expect(execute(provider, computer)).resolves.toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    vi.mocked(desktop.commands.run).mockRejectedValueOnce(
      new TimeoutError("deadline_exceeded: command timeout"),
    );
    await expect(execute(provider, computer)).resolves.toEqual([
      { type: "stderr", data: "command timed out after 42 ms\n" },
      { type: "exit", code: 124 },
    ]);
    const transport = new TimeoutError("canceled: requestTimeoutMs exceeded");
    vi.mocked(desktop.commands.run).mockRejectedValueOnce(transport);
    await expect(execute(provider, computer)).rejects.toBe(transport);
  });

  it("surfaces failed pauses and deletes paused computers without resuming them", async () => {
    const { provider, computer, sdk } = await started();
    const failure = new RateLimitError("pause unavailable");
    vi.mocked(sdk.pause).mockRejectedValueOnce(failure);
    await expect(provider.stop(computer, ctx)).rejects.toBe(failure);
    await provider.stop(computer, ctx);
    await provider.destroy(computer, ctx);
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.kill).toHaveBeenCalledWith(computer.id, { apiKey: "test-novita-key" });
  });

  it("rejects traversal and oversized file reads before downloading file contents", async () => {
    const { provider, computer, desktop } = await started();
    await expect(
      provider.writeFile(computer, { path: "../escape", content: new Uint8Array() }, ctx),
    ).rejects.toThrow();
    expect(desktop.files.write).not.toHaveBeenCalled();
    await provider.writeFile(computer, { path: "large", content: new Uint8Array(5) }, ctx);
    await expect(provider.readFile(computer, "large", ctx, { maxBytes: 4 })).rejects.toThrow(
      "exceeds 4 bytes",
    );
    expect(desktop.files.read).not.toHaveBeenCalled();
  });

  it("uses token-protected view and control sessions for multiple bot screens", async () => {
    const { provider, computer } = await started();
    const first = await provider.connectScreen(computer, { view: "stream" }, ctx);
    const second = await provider.connectScreen(
      computer,
      { view: "stream" },
      { ...ctx, botId: "other" },
    );
    expect(first.url).not.toBe(second.url);
    const view = new URL(first.url!);
    expect(view.protocol).toBe("https:");
    expect(view.searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    await provider.setScreenControl(computer, true, ctx, "test-control-token");
    const controlled = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "test-control-token" },
      ctx,
    );
    expect(new URL(controlled.url!).searchParams.get("path")).toBe(
      "websockify?token=test-control-token",
    );
    await provider.setScreenControl(computer, false, ctx, "test-control-token");
  });

  it("only marks a lost machine as gone after reconnect confirms its absence", async () => {
    const { provider, computer, machines } = await started();
    machines.delete(computer.id);
    await expect(provider.listFiles(computer, "", ctx)).rejects.toSatisfy(isSandboxGoneError);
    expect(new SandboxNotFoundError("gone").name).toBe("SandboxNotFoundError");
  });
});
