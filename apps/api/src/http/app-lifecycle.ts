import type { UserDeviceHub } from "@rakazo/adapters";

export interface AppLifecycle {
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  /** Node `upgrade` listener for desktop device sockets; absent when the feature is off. */
  handleUpgrade?: UserDeviceHub["handleUpgrade"];
  /**
   * Stops this process. With `letRunsFinish`, the runs it is executing first end their turn, for
   * up to RUN_DRAIN_MS, while it claims nothing new; otherwise, or when a later stop arrives
   * without it, they are handed back at once. Either way, new runs stop at once; the rest waits
   * for `connectionsClosed`, which settles once the server has stopped taking requests.
   */
  stop: (options?: { letRunsFinish?: boolean; connectionsClosed?: Promise<void> }) => Promise<void>;
}
