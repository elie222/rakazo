import type { AgentContextStrategy } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";

export type SilentContinuationMode = "ask" | "keep_going";

export interface AgentLoopSettings {
  openWorkLoop: {
    enabled: boolean;
    maxRewakes: number;
    maxWallClockMs: number;
    stallThreshold: number;
  };
  nonBlockingAsks: boolean;
  silentToolContinuations: {
    max: number;
    mode: SilentContinuationMode;
  };
  /** When set, overrides the deployment default context strategy for runs. */
  contextStrategy?: AgentContextStrategy;
  /** With `current` strategy, compact long threads (existing behavior) and pin open work in summaries. */
  contextCompactionPinOpenWork: boolean;
  /** Expose idle-but-waiting-on-child state on thread meta (backend only until UI lands). */
  waitingOnChildIndicator: boolean;
}

const DEFAULT_OPEN_WORK_LOOP = {
  enabled: false,
  maxRewakes: 12,
  maxWallClockMs: 45 * 60_000,
  stallThreshold: 3,
} as const;

const DEFAULT_SILENT_CONTINUATIONS = {
  max: 3,
  mode: "ask" as const,
};

export const DEFAULT_AGENT_LOOP_SETTINGS: AgentLoopSettings = {
  openWorkLoop: { ...DEFAULT_OPEN_WORK_LOOP },
  nonBlockingAsks: false,
  silentToolContinuations: { ...DEFAULT_SILENT_CONTINUATIONS },
  contextCompactionPinOpenWork: false,
  waitingOnChildIndicator: false,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function contextStrategyFromEnv(raw: string | undefined): AgentContextStrategy | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === "current" || value === "retrieval" || value === "snapshots" || value === "cache-aware") {
    return value;
  }
  return undefined;
}

function silentModeFromEnv(raw: string | undefined): SilentContinuationMode {
  const value = raw?.trim().toLowerCase();
  if (value === "keep_going" || value === "keep-going") return "keep_going";
  return "ask";
}

/** Self-host flags for autonomous open-work loops; defaults preserve upstream behavior. */
export function agentLoopSettingsFromEnv(source: NodeJS.ProcessEnv = process.env): AgentLoopSettings {
  const enabled = source.RAKAZO_OPEN_WORK_LOOP_ENABLED === "true";
  return {
    openWorkLoop: {
      enabled,
      maxRewakes: positiveInt(source.RAKAZO_OPEN_WORK_LOOP_MAX_REWAKES, DEFAULT_OPEN_WORK_LOOP.maxRewakes),
      maxWallClockMs: positiveInt(
        source.RAKAZO_OPEN_WORK_LOOP_MAX_WALL_CLOCK_MS,
        DEFAULT_OPEN_WORK_LOOP.maxWallClockMs,
      ),
      stallThreshold: positiveInt(
        source.RAKAZO_OPEN_WORK_LOOP_STALL_THRESHOLD,
        DEFAULT_OPEN_WORK_LOOP.stallThreshold,
      ),
    },
    nonBlockingAsks: source.RAKAZO_NON_BLOCKING_ASKS_ENABLED === "true",
    silentToolContinuations: {
      max: positiveInt(
        source.RAKAZO_SILENT_TOOL_CONTINUATIONS_MAX,
        DEFAULT_SILENT_CONTINUATIONS.max,
      ),
      mode: silentModeFromEnv(source.RAKAZO_SILENT_TOOL_CONTINUATION_MODE),
    },
    contextStrategy: contextStrategyFromEnv(source.RAKAZO_AGENT_CONTEXT_STRATEGY),
    contextCompactionPinOpenWork: source.RAKAZO_AGENT_CONTEXT_COMPACTION_PIN_OPEN_WORK === "true",
    waitingOnChildIndicator: source.RAKAZO_WAITING_ON_CHILD_INDICATOR === "true",
  };
}

/** Effective context strategy: env override when set, otherwise deployment default. */
export function effectiveContextStrategy(
  settings: AgentLoopSettings,
  deploymentDefault: AgentContextStrategy = DEFAULT_CONTEXT_STRATEGY,
): AgentContextStrategy {
  return settings.contextStrategy ?? deploymentDefault;
}

export function silentToolContinuationPrompt(mode: SilentContinuationMode, allowSilentEmpty: boolean): string {
  if (mode === "keep_going") {
    return allowSilentEmpty
      ? "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. Try another approach when the last one stalled. Ask the user only for hard limits you cannot infer. If you were instructed to stay silent when there is nothing to report, follow that for the entire final reply."
      : "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. Try another approach when the last one stalled. Ask the user only for hard limits you cannot infer; otherwise finish with a clear final answer.";
  }
  return allowSilentEmpty
    ? "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing, even if you were told to stay silent. Otherwise, if you were instructed to stay silent when there is nothing to report, follow that instruction for the entire final assistant reply; if not, use any remaining tools needed, then give the user the final answer."
    : "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing; otherwise use any remaining tools needed, then give the user the final answer.";
}
