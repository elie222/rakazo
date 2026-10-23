import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * Active conversational/foreground runs for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  select: { status: true },
} as const;

/** Waiting, running, then leased work wins over queued work, regardless of creation order. */
export function primaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_takeover" || run.status === "waiting_input") ??
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "leased") ??
    runs[0]
  );
}

/** Latest user-visible run for a bot roster error signal; later success clears an older failure. */
export const latestBotRunSelection = {
  where: { trigger: { notIn: userVisibleBotRunTriggers } },
  orderBy: latestBotRunOrderBy,
  take: 1,
  select: { id: true, status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}
