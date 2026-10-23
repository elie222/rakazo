import { getHeapStatistics } from "node:v8";
import type { BackgroundJobExecution } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";

/** Tracks agent lifetimes separately from short wakeup deliveries. */
export class RunExecutionHost {
  private stopping = false;
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly capacityWaiters = new Set<() => void>();

  start(): void {
    this.stopping = false;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const notify of this.capacityWaiters) notify();
    await Promise.allSettled(this.activeRuns);
  }

  async execute(execute: (execution: BackgroundJobExecution) => Promise<void>): Promise<void> {
    // A waiting network request consumes no dispatch capacity. Admit independent
    // runs while the process has memory headroom, rather than limiting their count.
    // Under real pressure, wait for a resident run to finish before loading more
    // histories. With no resident runs, allow work to resume instead of deadlocking
    // behind a heap that has not been collected yet.
    while (this.activeRuns.size > 0) {
      if (this.stopping) throw new Error("Worker is stopping");
      const heap = getHeapStatistics();
      // Image bytes and their base64/JSON copies live outside the JS heap.
      // Reserve four attachment budgets per resident run, including one that
      // has not loaded its history yet; also respect the OS/container headroom.
      const reserve = ATTACHMENT_MAX_BYTES * 4 * (this.activeRuns.size + 1);
      if (
        heap.used_heap_size + heap.external_memory + reserve < heap.heap_size_limit * 0.75 &&
        process.availableMemory() > reserve
      )
        break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.capacityWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 1_000);
        timer.unref?.();
        this.capacityWaiters.add(finish);
      });
    }
    if (this.stopping) throw new Error("Worker is stopping");
    let onRunStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      onRunStarted = resolve;
    });
    const executing = execute({ onRunStarted });
    const finish = () => {
      this.activeRuns.delete(tracked);
      for (const notify of this.capacityWaiters) notify();
    };
    // runCorrelatedJob reports failures in their original context. Observe the
    // rejection after handoff without reporting it again. Before handoff, the
    // original rejecting promise below still reaches Graphile's retry handling.
    const tracked = executing.then(finish, finish);
    this.activeRuns.add(tracked);
    await Promise.race([started, executing]);
  }
}
