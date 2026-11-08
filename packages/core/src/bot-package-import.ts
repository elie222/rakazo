import type {
  BotPackageImportInput,
  BotPackagePreview,
  BotPackagePreviewInput,
  BotPackageReceipt,
  BotPackageRecentReceipt,
} from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_BYTES, botPackageUtf8Bytes } from "@rakazo/contracts";

export type BotPackageImportState = {
  source: string;
  name: string;
  includeMemory: boolean;
  phase: "editing" | "previewing" | "review" | "importing" | "checking" | "unknown" | "completed";
  preview: BotPackagePreview | null;
  receipt: BotPackageReceipt | null;
  clientNonce: string | null;
  error: unknown | null;
  recent: BotPackageRecentReceipt[];
  recentLoading: boolean;
  recentError: unknown | null;
  canRetry: boolean;
};

export const initialBotPackageImport: BotPackageImportState = {
  source: "",
  name: "",
  includeMemory: false,
  phase: "editing",
  preview: null,
  receipt: null,
  clientNonce: null,
  error: null,
  recent: [],
  recentLoading: false,
  recentError: null,
  canRetry: false,
};

type Deps = {
  preview(input: BotPackagePreviewInput, signal: AbortSignal): Promise<BotPackagePreview>;
  import(input: BotPackageImportInput, signal: AbortSignal): Promise<BotPackageReceipt>;
  status(input: { clientNonce: string }, signal: AbortSignal): Promise<BotPackageReceipt | null>;
  recent(signal: AbortSignal): Promise<BotPackageRecentReceipt[]>;
  resume(input: { clientNonce: string }, signal: AbortSignal): Promise<BotPackageReceipt>;
  cancel(input: { clientNonce: string }, signal: AbortSignal): Promise<BotPackageReceipt>;
  newNonce(): string;
  isCurrent(): boolean;
  changed(state: BotPackageImportState): void;
};

function settled(receipt: BotPackageReceipt | null): boolean {
  return receipt !== null && ["completed", "cancelled", "removed"].includes(receipt.status);
}

/** A lost response retains its intent until the server settles or cancels that nonce. */
export function createBotPackageImport(deps: Deps) {
  let state = initialBotPackageImport;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  let recentGeneration = 0;
  let recentPending: AbortController | null = null;
  const active = () => !disposed && deps.isCurrent();
  const current = (version: number) => active() && version === generation;
  function publish(next: BotPackageImportState) {
    state = next;
    deps.changed(next);
  }
  function invalidate() {
    generation++;
    pending?.abort();
    pending = null;
  }
  function begin(phase: BotPackageImportState["phase"], clientNonce = state.clientNonce) {
    invalidate();
    const controller = new AbortController();
    pending = controller;
    const version = generation;
    publish({ ...state, phase, clientNonce, error: null, canRetry: false });
    return { controller, version };
  }
  function receive(receipt: BotPackageReceipt, nonce: string) {
    if (receipt.clientNonce !== nonce) throw new Error("Could not confirm this import.");
    if (
      state.receipt !== null &&
      (receipt.importId !== state.receipt.importId || receipt.revision < state.receipt.revision)
    )
      throw new Error("Could not confirm the current import receipt.");
    const digest = state.preview?.digest ?? state.receipt?.digest;
    if (digest && receipt.status !== "cancelled" && receipt.digest !== digest)
      throw new Error("Could not confirm the reviewed package.");
    const done = settled(receipt);
    publish({
      ...state,
      ...(done ? { source: "", name: "", includeMemory: false, preview: null } : {}),
      phase: done ? "completed" : "unknown",
      receipt,
      clientNonce: nonce,
      error: null,
      canRetry: !done,
    });
  }
  async function write(
    nonce: string,
    request: (signal: AbortSignal) => Promise<BotPackageReceipt>,
  ) {
    const { controller, version } = begin("importing", nonce);
    if (!current(version)) return;
    try {
      const receipt = await request(controller.signal);
      if (current(version)) receive(receipt, nonce);
    } catch (error) {
      if (current(version)) publish({ ...state, phase: "unknown", error, canRetry: false });
    } finally {
      if (current(version)) pending = null;
    }
  }
  async function check() {
    const nonce = state.clientNonce;
    if (
      !active() ||
      !nonce ||
      settled(state.receipt) ||
      state.phase === "importing" ||
      state.phase === "checking"
    )
      return;
    const { controller, version } = begin("checking", nonce);
    if (!current(version)) return;
    try {
      const receipt = await deps.status({ clientNonce: nonce }, controller.signal);
      if (!current(version)) return;
      if (receipt) receive(receipt, nonce);
      else if (state.receipt) {
        publish({
          ...state,
          phase: "unknown",
          error: new Error("Could not confirm the existing import receipt."),
          canRetry: false,
        });
      } else {
        // Absence is not a fence against an earlier request arriving later. Keep this nonce locked.
        publish({ ...state, phase: "unknown", receipt: null, error: null, canRetry: true });
      }
    } catch (error) {
      if (current(version)) publish({ ...state, phase: "unknown", error, canRetry: false });
    } finally {
      if (current(version)) pending = null;
    }
  }
  return {
    edit(input: Partial<Pick<BotPackageImportState, "source" | "name" | "includeMemory">>) {
      if (!active() || state.clientNonce !== null) return;
      if (
        (input.source === undefined || input.source === state.source) &&
        (input.name === undefined || input.name === state.name) &&
        (input.includeMemory === undefined || input.includeMemory === state.includeMemory)
      )
        return;
      invalidate();
      publish({
        ...state,
        ...input,
        phase: "editing",
        preview: null,
        error: null,
        canRetry: false,
      });
    },
    async preview() {
      if (!active() || state.clientNonce !== null || state.phase === "previewing") return;
      if (!state.source.trim() || botPackageUtf8Bytes(state.source) > BOT_PACKAGE_MAX_BYTES) {
        publish({
          ...state,
          phase: "editing",
          preview: null,
          error: new Error("Choose a package of at most 4 MiB."),
        });
        return;
      }
      const input = {
        source: state.source,
        ...(state.name.trim() ? { name: state.name } : {}),
        includeMemory: state.includeMemory,
      };
      const { controller, version } = begin("previewing");
      if (!current(version)) return;
      try {
        const preview = await deps.preview(input, controller.signal);
        if (!current(version)) return;
        if (preview.includeMemory !== input.includeMemory)
          throw new Error("Could not confirm the preview options.");
        publish({ ...state, phase: "review", preview, receipt: null, error: null });
      } catch (error) {
        if (current(version)) publish({ ...state, phase: "editing", preview: null, error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    async confirm() {
      const preview = state.preview;
      if (
        !active() ||
        !preview ||
        (state.phase !== "review" &&
          !(state.phase === "unknown" && state.canRetry && state.receipt === null))
      )
        return;
      const nonce = state.clientNonce ?? deps.newNonce();
      await write(nonce, (signal) =>
        deps.import({ previewToken: preview.previewToken, clientNonce: nonce }, signal),
      );
    },
    check,
    async recover(clientNonce: string) {
      if (
        !active() ||
        state.phase === "importing" ||
        state.phase === "checking" ||
        (state.clientNonce !== null && !settled(state.receipt) && state.clientNonce !== clientNonce)
      )
        return;
      if (state.clientNonce === clientNonce) {
        await check();
        return;
      }
      invalidate();
      publish({
        ...state,
        source: "",
        name: "",
        includeMemory: false,
        preview: null,
        receipt: null,
        clientNonce,
        phase: "unknown",
        error: null,
        canRetry: false,
      });
      await check();
    },
    async resume() {
      const nonce = state.clientNonce;
      if (
        !active() ||
        !nonce ||
        state.phase !== "unknown" ||
        !state.canRetry ||
        !state.receipt ||
        !["importing", "failed"].includes(state.receipt.status)
      )
        return;
      await write(nonce, (signal) => deps.resume({ clientNonce: nonce }, signal));
    },
    async cancel() {
      const nonce = state.clientNonce;
      if (!active() || !nonce || settled(state.receipt)) return;
      // Cancellation is a server fence, including for a nonce whose first request is still in transit.
      await write(nonce, (signal) => deps.cancel({ clientNonce: nonce }, signal));
    },
    reset() {
      if (!active() || (state.clientNonce !== null && !settled(state.receipt))) return false;
      invalidate();
      publish({
        ...initialBotPackageImport,
        recent: state.recent,
        recentLoading: state.recentLoading,
        recentError: state.recentError,
      });
      return true;
    },
    async loadRecent() {
      if (!active()) return;
      recentPending?.abort();
      const controller = new AbortController();
      recentPending = controller;
      const version = ++recentGeneration;
      publish({ ...state, recentLoading: true, recentError: null });
      try {
        const recent = await deps.recent(controller.signal);
        if (active() && version === recentGeneration)
          publish({ ...state, recent, recentLoading: false, recentError: null });
      } catch (error) {
        if (active() && version === recentGeneration)
          publish({ ...state, recentLoading: false, recentError: error });
      } finally {
        if (active() && version === recentGeneration) recentPending = null;
      }
    },
    dispose() {
      disposed = true;
      invalidate();
      recentGeneration++;
      recentPending?.abort();
      recentPending = null;
    },
  };
}

export type BotPackageImport = ReturnType<typeof createBotPackageImport>;
