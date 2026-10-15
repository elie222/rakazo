import type { NativeLoginAccount } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeLoginMonitor } from "./native-login-monitor.js";

const pending: NativeLoginAccount = {
  credentialId: "account-one",
  harness: "codex",
  computerId: "computer-one",
  endpoint: "https://chatgpt.com/backend-api/codex",
  label: "Personal",
  state: {
    state: "pending",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "TEST-1234",
    expiresAt: null,
  },
};
afterEach(() => vi.useRealTimers());
it("polls only pending accounts and stops after completion", async () => {
  vi.useFakeTimers();
  const ready = { ...pending, state: { state: "ready" as const, accountLabel: null, plan: null } };
  const status = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready);
  const onUpdate = vi.fn();
  const monitor = createNativeLoginMonitor({ status, onUpdate, onError: vi.fn() });
  monitor.start(pending);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(status).toHaveBeenCalledTimes(2);
  expect(onUpdate).toHaveBeenLastCalledWith(ready);
  expect(vi.getTimerCount()).toBe(0);
});
it("ignores a stale completion after cancel, unmount, logout or another account starts", async () => {
  vi.useFakeTimers();
  let resolve!: (account: NativeLoginAccount) => void;
  const status = vi.fn(
    () =>
      new Promise<NativeLoginAccount>((done) => {
        resolve = done;
      }),
  );
  const onUpdate = vi.fn();
  const monitor = createNativeLoginMonitor({ status, onUpdate, onError: vi.fn() });
  monitor.start(pending);
  await vi.advanceTimersByTimeAsync(3_000);
  monitor.stop();
  resolve({ ...pending, state: { state: "ready", accountLabel: null, plan: null } });
  await Promise.resolve();
  expect(onUpdate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("expires polling at the earlier server deadline", async () => {
  vi.useFakeTimers();
  const onUpdate = vi.fn();
  const status = vi.fn().mockResolvedValue(pending);
  const monitor = createNativeLoginMonitor({ status, onUpdate, onError: vi.fn() });
  monitor.start({
    ...pending,
    state: {
      ...pending.state,
      state: "pending",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "TEST-1234",
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    },
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(status).not.toHaveBeenCalled();
  expect(onUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ state: { state: "failed", code: "expired" } }),
  );
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects mismatched account results and stops on transport errors", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const onUpdate = vi.fn();
  const monitor = createNativeLoginMonitor({
    status: vi.fn().mockResolvedValue({ ...pending, credentialId: "wrong-account" }),
    onUpdate,
    onError,
  });
  monitor.start(pending);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(onUpdate).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a hanging status request and ignores its eventual result", async () => {
  vi.useFakeTimers();
  let resolve!: (account: NativeLoginAccount) => void;
  const onUpdate = vi.fn();
  const monitor = createNativeLoginMonitor({
    status: () =>
      new Promise((done) => {
        resolve = done;
      }),
    onUpdate,
    onError: vi.fn(),
    maxDurationMs: 4_000,
  });
  monitor.start(pending);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(onUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ state: { state: "failed", code: "expired" } }),
  );
  resolve({ ...pending, state: { state: "ready", accountLabel: null, plan: null } });
  await Promise.resolve();
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
