import type { BotPackageExport, BotPackageExportInput } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_BYTES, botPackageUtf8Bytes } from "@rakazo/contracts";

export type BotPackageExportState = {
  phase: "idle" | "exporting" | "review" | "delivering" | "completed" | "error";
  result: BotPackageExport | null;
  error: unknown | null;
};

export const initialBotPackageExport: BotPackageExportState = {
  phase: "idle",
  result: null,
  error: null,
};

type Deps = {
  export(input: BotPackageExportInput, signal: AbortSignal): Promise<BotPackageExport>;
  deliver(result: BotPackageExport, signal: AbortSignal): Promise<void>;
  isCurrent(): boolean;
  changed(state: BotPackageExportState): void;
};

/** Platform delivery must recheck the captured scope immediately before its irreversible handoff. */
export function createBotPackageExport(deps: Deps) {
  let state = initialBotPackageExport;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  const current = (version: number) => !disposed && deps.isCurrent() && version === generation;
  function publish(next: BotPackageExportState) {
    state = next;
    deps.changed(next);
  }
  return {
    async run(input: BotPackageExportInput) {
      if (disposed || !deps.isCurrent() || state.phase === "delivering") return;
      const requested = { ...input, skillIds: [...input.skillIds] };
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const version = ++generation;
      publish({ phase: "exporting", result: null, error: null });
      if (!current(version)) return;
      try {
        const result = await deps.export(requested, controller.signal);
        if (!current(version)) return;
        if (botPackageUtf8Bytes(result.json) > BOT_PACKAGE_MAX_BYTES)
          throw new Error("The package is larger than 4 MiB.");
        publish({ phase: "review", result, error: null });
      } catch (error) {
        if (current(version)) publish({ phase: "error", result: null, error });
      } finally {
        if (pending === controller) pending = null;
      }
    },
    async confirm() {
      if (disposed || !deps.isCurrent() || state.phase !== "review" || !state.result) return;
      const result = state.result;
      const version = generation;
      const controller = new AbortController();
      pending = controller;
      publish({ phase: "delivering", result, error: null });
      if (!current(version)) return;
      try {
        await deps.deliver(result, controller.signal);
        if (current(version)) publish({ phase: "completed", result, error: null });
      } catch (error) {
        if (current(version)) publish({ phase: "error", result: null, error });
      } finally {
        if (pending === controller) pending = null;
      }
    },
    invalidate() {
      if (disposed || !deps.isCurrent() || state.phase === "delivering") return;
      generation++;
      pending?.abort();
      pending = null;
      publish(initialBotPackageExport);
    },
    dispose() {
      disposed = true;
      generation++;
      pending?.abort();
      pending = null;
    },
  };
}
