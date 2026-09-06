import { createHash } from "node:crypto";
import { type ModalClient, NotFoundError } from "modal";
import { describe, expect, it, vi } from "vitest";
import { ModalSandboxProvider } from "./modal-sandbox.js";

const context = {
  spaceId: "space",
  userId: "user",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
const computer = { id: "sb-test", providerRef: "sb-test", kind: "modal" as const, botId: "bot" };
function fixture() {
  const owner = createHash("sha256")
    .update(JSON.stringify([context.spaceId, computer.botId]))
    .digest("hex");
  const requests: Record<string, unknown>[] = [];
  const sandbox = {
    sandboxId: computer.id,
    getTags: vi.fn(async () => ({ cadre_owner: owner })),
    poll: vi.fn(async () => null),
    tunnels: vi.fn(async () => ({ 8080: { url: "https://computer.modal.host" } })),
    terminate: vi.fn(async () => {}),
    exec: vi.fn(async () => {
      let input: Record<string, unknown> = {};
      const chunks: Buffer[] = [];
      const write = async (value: Uint8Array) => {
        if (value.byteLength > 20 * 1024 * 1024) throw new Error("Modal stdin message too large");
        chunks.push(Buffer.from(value));
      };
      return {
        stdin: {
          writeText: async (value: string) => write(Buffer.from(value)),
          writeBytes: write,
          close: async () => {
            input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push(input);
          },
        },
        stdout: {
          readText: async () =>
            JSON.stringify(input.op === "exec" ? { stdout: "ok", stderr: "", code: 0 } : {}),
        },
        stderr: { readText: async () => "" },
        wait: async () => 0,
      };
    }),
  };
  const client = {
    sandboxes: { fromId: vi.fn(async () => sandbox), fromName: vi.fn(async () => sandbox) },
  };
  const provider = new ModalSandboxProvider(
    { imageId: "im-test", screenSecret: "test-screen-secret-at-least-32-characters" },
    client as unknown as ModalClient,
  );
  return { provider, sandbox, client, requests };
}
describe("Modal sandbox boundary", () => {
  it("restores files whose encoded content exceeds one stdin message", async () => {
    const f = fixture();
    const content = Buffer.alloc(16 * 1024 * 1024, 0xa5);
    await f.provider.writeFile(computer, { path: "artifacts/恢复.bin", content }, context);
    expect(f.requests[0]?.path).toBe("artifacts/恢复.bin");
    expect(Buffer.from(String(f.requests[0]?.content), "base64").equals(content)).toBe(true);
  });
  it("reconnects without creating a new computer and executes bounded non-PTY commands", async () => {
    const f = fixture();
    expect(
      await f.provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: computer.id, providerKind: "modal" },
        context,
      ),
    ).toMatchObject({ fresh: false, providerRef: computer.id });
    const events = [];
    for await (const event of f.provider.execute(
      computer,
      { argv: ["echo", "ok"], timeoutMs: 99999999 },
      context,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "ok" },
      { type: "exit", code: 0 },
    ]);
    expect(f.requests[0]).toMatchObject({ op: "exec", timeoutMs: 3600000 });
    await expect(async () => {
      for await (const _ of f.provider.execute(computer, { argv: ["sh"], pty: true }, context)) {
      }
    }).rejects.toThrow("PTY");
  });
  it("checks ownership before execution, viewing, or termination", async () => {
    const f = fixture();
    const foreign = { ...context, spaceId: "other-space" };
    await expect(f.provider.observe(computer, foreign)).rejects.toThrow("access denied");
    await expect(f.provider.destroy(computer, foreign)).rejects.toThrow("access denied");
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.sandbox.terminate).not.toHaveBeenCalled();
  });
  it("separates viewing and takeover credentials and rejects missing control leases", async () => {
    const f = fixture();
    const view = await f.provider.connectScreen(computer, { view: "stream" }, context);
    await expect(
      f.provider.connectScreen(computer, { view: "stream", interactive: true }, context),
    ).rejects.toThrow("Control lease required");
    const control = await f.provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "control" },
      context,
    );
    expect(new URL(view.url).searchParams.get("cadre_token")).not.toBe("control");
    expect(new URL(control.url).searchParams.get("cadre_token")).toBe("control");
    await control.close();
    expect(f.requests).toEqual([
      { op: "screen", interactive: true, leaseId: "control", controlToken: "control" },
      { op: "screen", interactive: false, leaseId: "control", controlToken: "control" },
    ]);
  });
  it("normalizes missing computers for runtime recovery", async () => {
    const f = fixture();
    f.client.sandboxes.fromId.mockRejectedValue(new NotFoundError("missing"));
    await expect(f.provider.observe(computer, context)).rejects.toMatchObject({
      name: "SandboxNotFoundError",
    });
  });
  it("does not dispatch a command that was cancelled before execution", async () => {
    const f = fixture();
    await expect(async () => {
      for await (const _ of f.provider.execute(
        computer,
        { argv: ["echo"] },
        { ...context, signal: AbortSignal.abort() },
      )) {
      }
    }).rejects.toThrow();
    expect(f.sandbox.exec).not.toHaveBeenCalled();
  });
});
