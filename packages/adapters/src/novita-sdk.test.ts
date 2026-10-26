import type { DesktopSandbox } from "novita-sandbox";
import { describe, expect, it, vi } from "vitest";
import { novitaDesktop } from "./novita-sandbox.js";

function fixture() {
  const handle = {
    wait: vi.fn(async () => ({ exitCode: 0, stdout: "done", stderr: "" })),
    kill: vi.fn(async () => true),
    stdout: "partial",
  };
  const source = {
    sandboxId: "test-computer",
    commands: { run: vi.fn(async () => handle) },
    files: {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      write: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      getInfo: vi.fn(async () => ({ size: 3 })),
    },
  };
  const desktop = novitaDesktop(source as unknown as DesktopSandbox);
  return { handle, source, desktop };
}

describe("Novita SDK translation", () => {
  it("passes shell options and waits for the native command handle", async () => {
    const { desktop, source, handle } = fixture();
    const signal = new AbortController().signal;
    const options = { signal, timeoutMs: 42, cwd: "/workspace", envs: { NAME: "test" } };
    await expect(desktop.commands.run("echo test", options)).resolves.toEqual({
      exitCode: 0,
      stdout: "done",
      stderr: "",
    });
    expect(source.commands.run).toHaveBeenCalledWith("echo test", {
      background: true,
      timeoutMs: 42,
      cwd: "/workspace",
      envs: { NAME: "test" },
    });
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("does not start commands or file requests with an already-aborted signal", async () => {
    const { desktop, source } = fixture();
    const signal = AbortSignal.abort(new Error("canceled"));
    await expect(desktop.commands.run("side-effect", { signal })).rejects.toThrow("canceled");
    await expect(desktop.files.read("file", { format: "bytes", signal })).rejects.toThrow(
      "canceled",
    );
    await expect(
      desktop.files.write([{ path: "file", data: new ArrayBuffer(0) }], { signal }),
    ).rejects.toThrow("canceled");
    expect(source.commands.run).not.toHaveBeenCalled();
    expect(source.files.read).not.toHaveBeenCalled();
    expect(source.files.write).not.toHaveBeenCalled();
  });

  it("kills a command when canceled during execution and reports exit 130", async () => {
    const { desktop, handle } = fixture();
    const controller = new AbortController();
    let finish!: () => void;
    handle.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exitCode: 0, stdout: "done", stderr: "" });
        }),
    );
    handle.kill.mockImplementation(async () => {
      finish();
      return true;
    });
    const pending = desktop.commands.run("long-command", { signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    await expect(pending).resolves.toEqual({
      exitCode: 130,
      stdout: "partial",
      stderr: "command aborted\n",
    });
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it("kills a command canceled before the start response arrives", async () => {
    const { desktop, source, handle } = fixture();
    const controller = new AbortController();
    source.commands.run.mockImplementationOnce(async () => {
      controller.abort();
      return handle;
    });
    await expect(
      desktop.commands.run("long-command", { signal: controller.signal }),
    ).resolves.toMatchObject({ exitCode: 130 });
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it("surfaces a failed cancellation rather than claiming the remote process stopped", async () => {
    const { desktop, source, handle } = fixture();
    const controller = new AbortController();
    source.commands.run.mockImplementationOnce(async () => {
      controller.abort();
      return handle;
    });
    handle.kill.mockRejectedValueOnce(new Error("kill unavailable"));
    await expect(
      desktop.commands.run("long-command", { signal: controller.signal }),
    ).rejects.toThrow("kill unavailable");
  });

  it("passes file bytes through the SDK without unsupported signal options", async () => {
    const { desktop, source } = fixture();
    const signal = new AbortController().signal;
    await expect(desktop.files.read("file", { format: "bytes", signal })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(source.files.read).toHaveBeenCalledWith("file", { format: "bytes" });
  });
});
