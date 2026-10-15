import type { NativeLoginAccount } from "@rakazo/contracts";

/** A UI-only status poller. The server owns authentication, expiry and credential storage. */
export function createNativeLoginMonitor(options: {
  status: (credentialId: string) => Promise<NativeLoginAccount>;
  onUpdate: (account: NativeLoginAccount) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
  maxDurationMs?: number;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function stop() {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    timer = undefined;
  }
  function start(account: NativeLoginAccount) {
    stop();
    if (account.state.state !== "pending") return;
    const current = generation;
    const expiresAt = account.state.expiresAt ? Date.parse(account.state.expiresAt) : NaN;
    const deadline = Math.min(
      Date.now() + (options.maxDurationMs ?? 15 * 60_000),
      Number.isFinite(expiresAt) ? expiresAt : Infinity,
    );
    function expire() {
      if (generation !== current) return;
      options.onUpdate({ ...account, state: { state: "failed", code: "expired" } });
      stop();
    }
    expiryTimer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    function schedule() {
      if (generation !== current) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        expire();
        return;
      }
      timer = setTimeout(() => void poll(), Math.min(options.intervalMs ?? 3_000, remaining));
    }
    async function poll() {
      if (generation !== current) return;
      if (Date.now() >= deadline) {
        schedule();
        return;
      }
      try {
        const next = await options.status(account.credentialId);
        if (generation !== current) return;
        if (next.credentialId !== account.credentialId) throw new Error("Sign-in account changed");
        options.onUpdate(next);
        if (next.state.state === "pending") schedule();
        else stop();
      } catch (error) {
        if (generation !== current) return;
        stop();
        options.onError(error);
      }
    }
    schedule();
  }
  return { start, stop };
}
