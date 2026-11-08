import type { BotPackageActivateSkillInput, BotPackageReceipt } from "@rakazo/contracts";

export type BotPackageSkillsState = {
  phase: "loading" | "ready" | "saving" | "unknown";
  receipt: BotPackageReceipt | null;
  error: unknown | null;
  unknownComponentId: string | null;
};

export const initialBotPackageSkills: BotPackageSkillsState = {
  phase: "loading",
  receipt: null,
  error: null,
  unknownComponentId: null,
};

type Deps = {
  botId: string;
  forBot(input: { botId: string }, signal: AbortSignal): Promise<BotPackageReceipt | null>;
  activateSkill(
    input: BotPackageActivateSkillInput,
    signal: AbortSignal,
  ): Promise<BotPackageReceipt>;
  isCurrent(): boolean;
  changed(state: BotPackageSkillsState): void;
};

/** Pending package instructions become shared skills only through an explicit revision-bound action. */
export function createBotPackageSkills(deps: Deps) {
  let state = initialBotPackageSkills;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  const current = (version: number) => !disposed && deps.isCurrent() && version === generation;
  function publish(next: BotPackageSkillsState) {
    state = next;
    deps.changed(next);
  }
  function begin(phase: BotPackageSkillsState["phase"]) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const version = ++generation;
    publish({ ...state, phase, error: null });
    return { controller, version };
  }
  function accept(receipt: BotPackageReceipt | null) {
    if (receipt !== null && receipt.botId !== deps.botId)
      throw new Error("Could not confirm this bot's imported skills.");
    if (
      receipt !== null &&
      state.receipt !== null &&
      (receipt.importId !== state.receipt.importId || receipt.revision < state.receipt.revision)
    )
      throw new Error("Could not confirm the current imported skills.");
    publish({ phase: "ready", receipt, error: null, unknownComponentId: null });
  }
  return {
    async refresh() {
      if (disposed || !deps.isCurrent()) return;
      const { controller, version } = begin("loading");
      if (!current(version)) return;
      try {
        const receipt = await deps.forBot({ botId: deps.botId }, controller.signal);
        if (current(version)) accept(receipt);
      } catch (error) {
        if (current(version)) publish({ ...state, phase: "unknown", error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    async activate(componentId: string, name?: string) {
      const receipt = state.receipt;
      const skill = receipt?.skills.find((entry) => entry.id === componentId);
      if (
        disposed ||
        !deps.isCurrent() ||
        state.phase !== "ready" ||
        receipt?.status !== "completed" ||
        !skill ||
        skill.status !== "pending"
      )
        return;
      const { controller, version } = begin("saving");
      if (!current(version)) return;
      try {
        const next = await deps.activateSkill(
          { componentId, expectedRevision: skill.revision, ...(name?.trim() ? { name } : {}) },
          controller.signal,
        );
        if (!current(version)) return;
        if (next.importId !== receipt.importId || next.revision < receipt.revision)
          throw new Error("Could not confirm this skill change.");
        accept(next);
      } catch (error) {
        if (current(version))
          publish({ ...state, phase: "unknown", error, unknownComponentId: componentId });
      } finally {
        if (current(version)) pending = null;
      }
    },
    dispose() {
      disposed = true;
      generation++;
      pending?.abort();
      pending = null;
    },
  };
}

export type BotPackageSkills = ReturnType<typeof createBotPackageSkills>;
