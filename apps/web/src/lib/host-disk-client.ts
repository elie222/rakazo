import type { HostDiskOperation, HostDiskSettings } from "@rakazo/contracts";
import { desktopBridge } from "./desktop";
import { rpc } from "./rpc";

const HEARTBEAT_MS = 30_000;
const CLAIM_MS = 1_500;

/**
 * While the desktop app has host-disk access on, keep a heartbeat and fulfill
 * bridged file operations from the worker/API.
 */
export function startHostDiskClient(): () => void {
  const desktop = desktopBridge();
  if (!desktop?.hostDisk) return () => undefined;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let roots: string[] = [];
  let enabled = false;

  async function refreshSettings(): Promise<HostDiskSettings | null> {
    try {
      const settings = await rpc.hostDisk.get();
      enabled = settings.enabled;
      roots = settings.roots;
      return settings;
    } catch {
      enabled = false;
      roots = [];
      return null;
    }
  }

  async function heartbeat() {
    if (!enabled || roots.length === 0) return;
    try {
      await rpc.hostDisk.heartbeat();
    } catch {
      // Ignore transient network errors; the next tick retries.
    }
  }

  async function fulfill(operation: HostDiskOperation) {
    if (!desktop?.hostDisk) return;
    try {
      if (operation.kind === "list") {
        const entries = await desktop.hostDisk.list(operation.path);
        await rpc.hostDisk.complete({
          id: operation.id,
          status: "done",
          entries,
        });
        return;
      }
      if (operation.kind === "read") {
        const contentBase64 = await desktop.hostDisk.read(operation.path, operation.maxBytes);
        await rpc.hostDisk.complete({
          id: operation.id,
          status: "done",
          contentBase64,
        });
        return;
      }
      if (operation.kind === "write") {
        await desktop.hostDisk.write(operation.path, operation.contentBase64 ?? "");
        await rpc.hostDisk.complete({ id: operation.id, status: "done" });
      }
    } catch (error) {
      await rpc.hostDisk
        .complete({
          id: operation.id,
          status: "error",
          error: error instanceof Error ? error.message : "Host disk operation failed",
        })
        .catch(() => undefined);
    }
  }

  async function tick() {
    if (stopped) return;
    const settings = await refreshSettings();
    if (settings?.enabled && settings.roots.length > 0) {
      await heartbeat();
      try {
        const operation = await rpc.hostDisk.claim();
        if (operation) await fulfill(operation);
      } catch {
        // Ignore; retry on the next claim interval.
      }
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), enabled && roots.length > 0 ? CLAIM_MS : HEARTBEAT_MS);
    }
  }

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
