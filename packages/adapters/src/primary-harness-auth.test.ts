import type {
  ComputerRef,
  ProcessEvent,
  SandboxProcessRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { NativeLoginDescriptor, NativeLoginState } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  parseModelSecret,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
} from "./pi-oauth.js";
import type { NativeHarnessLoginOptions } from "./primary-harness-auth.js";
import {
  inspectNativeHarnessLogin,
  logoutNativeHarnessLogin,
  startNativeHarnessLogin,
  validateNativeLoginState,
} from "./primary-harness-auth.js";
import { NativeEventQueue } from "./primary-harness-protocol.js";

const descriptor: NativeLoginDescriptor = {
  kind: "native_login",
  installationId: "a".repeat(32),
  harness: "codex",
  connectionId: "11111111-1111-4111-8111-111111111111",
  epoch: "22222222-2222-4222-8222-222222222222",
  computerId: "db-computer",
  computerProviderRef: "private-container",
  computerHomeKey: "computer-owner-bot",
  spaceId: "space",
  region: "global",
  state: "pending",
};
function pending(): NativeLoginState {
  return {
    state: "pending",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "FAKE-CODE",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
}
function fixture(
  status: NativeLoginState = { state: "ready", accountLabel: "test@example.invalid", plan: "plus" },
) {
  const events = new NativeEventQueue<ProcessEvent>();
  const messages: Record<string, unknown>[] = [];
  const push = (frame: unknown) =>
    events.push({ type: "stdout", data: `${JSON.stringify(frame)}\n` });
  const terminate = vi.fn(async () => events.end());
  const process = {
    events,
    terminate,
    closeStdin: async () => {},
    writeStdin: async (data: string) => {
      const message = JSON.parse(data);
      messages.push(message);
      const result =
        message.method === "rakazo/auth/start"
          ? pending()
          : message.method === "rakazo/auth/logout"
            ? { state: "signed_out" }
            : message.method === "rakazo/auth/cancel"
              ? { state: "failed", code: "cancelled" }
              : status;
      push({ id: message.id, result });
      if (message.method === "rakazo/auth/cancel")
        push({ method: "rakazo/auth/state", params: result });
    },
  };
  const startProcess = vi.fn(
    async (_computer: ComputerRef, _request: SandboxProcessRequest) => process,
  );
  const options: NativeHarnessLoginOptions = {
    descriptor: { ...descriptor },
    computer: {
      id: "private-container",
      providerRef: "private-container",
      kind: "docker",
      botId: "computer-owner-bot",
    },
    context: {
      operationId: "native-auth-op",
      traceId: "native-auth-trace",
      spaceId: "space",
      userId: "user",
      botId: "login",
      runId: "login",
      signal: new AbortController().signal,
    },
    sandbox: {
      startProcess,
      nativeStateInstallationId: () => "a".repeat(32),
    } as unknown as SandboxProvider,
  };
  return { options, startProcess, terminate, messages, push, process };
}
describe("native login private transport boundary", () => {
  it("returns only bounded owner-verification state, then sanitized completion, and closes the process", async () => {
    const f = fixture();
    const login = await startNativeHarnessLogin(f.options);
    expect(login.initial.state).toBe("pending");
    expect(f.startProcess).toHaveBeenCalledWith(
      f.options.computer,
      expect.objectContaining({
        credentialScope: {
          harness: "codex",
          connectionId: descriptor.connectionId,
          epoch: descriptor.epoch,
        },
      }),
      expect.anything(),
    );
    expect(f.startProcess.mock.calls[0]?.[1]).not.toHaveProperty("env");
    f.push({
      method: "rakazo/auth/state",
      params: { state: "ready", accountLabel: "owner", plan: null, access_token: "never-return" },
    });
    expect(await login.completion).toEqual({ state: "ready", accountLabel: "owner", plan: null });
    expect(f.terminate).toHaveBeenCalledOnce();
  });
  it("cancels pending native polling and closes even when completion races the response", async () => {
    const f = fixture();
    const login = await startNativeHarnessLogin(f.options);
    await login.cancel();
    expect(await login.completion).toEqual({ state: "failed", code: "cancelled" });
    expect(f.terminate).toHaveBeenCalled();
  });
  it("terminates unresponsive cancellation after a short grace", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const login = await startNativeHarnessLogin(f.options);
      f.process.writeStdin = async () => {};
      const cancelling = login.cancel();
      await vi.advanceTimersByTimeAsync(1000);
      await cancelling;
      expect(f.terminate).toHaveBeenCalledOnce();
      expect(await login.completion).toEqual({ state: "failed", code: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds status operations independently from the device login lifetime", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.process.writeStdin = async () => {};
      const result = inspectNativeHarnessLogin(f.options).catch((error) => error);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await result).toBeInstanceOf(Error);
      expect(f.startProcess.mock.calls[0]?.[1].timeoutMs).toBe(30000);
      expect(f.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("inspects persisted account state and disconnects only through the native operation", async () => {
    const f = fixture();
    expect(await inspectNativeHarnessLogin(f.options)).toEqual({
      state: "ready",
      accountLabel: "test@example.invalid",
      plan: "plus",
    });
    const g = fixture();
    await logoutNativeHarnessLogin(g.options);
    expect(g.messages[0]?.method).toBe("rakazo/auth/logout");
  });
  it("denies unknown native requests and never surfaces their raw error content", async () => {
    const f = fixture();
    const login = await startNativeHarnessLogin(f.options);
    f.push({ id: "native", method: "run/shell", params: { secret: "private" } });
    expect(await login.completion).toEqual({ state: "failed", code: "unavailable" });
    expect(f.terminate).toHaveBeenCalled();
  });
  it.each(["spaceId", "computerProviderRef", "computerHomeKey"] as const)(
    "rejects changed owner/computer scope %s before launch",
    async (key) => {
      const f = fixture();
      f.options.descriptor[key] = "another-scope";
      await expect(startNativeHarnessLogin(f.options)).rejects.toThrow("does not match");
      expect(f.startProcess).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://auth.openai.com.attacker.invalid/login",
    "http://auth.openai.com/login",
    "https://user:password@auth.openai.com/login",
    "https://auth.openai.com/login#secret",
  ])("rejects untrusted verification address %s", (uri) => {
    expect(() =>
      validateNativeLoginState({ ...pending(), verificationUri: uri }, "codex"),
    ).toThrow();
  });
  it("rejects stale/unbounded expiry and malformed user codes", () => {
    for (const extra of [
      { expiresAt: null },
      { expiresAt: new Date(Date.now() - 1).toISOString() },
      { expiresAt: new Date(Date.now() + 3600000).toISOString() },
      { userCode: "bad\ncode" },
    ])
      expect(() => validateNativeLoginState({ ...pending(), ...extra }, "codex")).toThrow();
  });
});
describe("native model descriptor", () => {
  it("roundtrips only the nonsecret descriptor and refuses the Pi/API-key resolver", async () => {
    const serialized = serializeModelSecret(descriptor);
    expect(parseModelSecret(serialized)).toEqual(descriptor);
    expect(secretValuesToRedact(descriptor)).toEqual([]);
    await expect(resolveModelAuth(serialized, "native-codex")).rejects.toThrow(
      "isolated native harness",
    );
  });
  it("does not downgrade malformed native descriptors into literal API keys", () => {
    expect(() => parseModelSecret(JSON.stringify({ ...descriptor, epoch: "invalid" }))).toThrow(
      "corrupt",
    );
  });
});
