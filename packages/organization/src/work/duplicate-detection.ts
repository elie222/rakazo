/**
 * Deterministic duplicate detection for WorkItems.
 * Uses normalized title + project + source event key.
 */

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildWorkItemIdempotencyKey(input: {
  workspaceId: string;
  projectId?: string | null;
  parentWorkItemId?: string | null;
  title: string;
  source?: string;
  sourceEventId?: string | null;
}): string {
  const nTitle = normalizeTitle(input.title);
  const parts = [
    input.workspaceId,
    input.projectId ?? "no-project",
    input.parentWorkItemId ?? "no-parent",
    nTitle,
    input.source ?? "manual",
    input.sourceEventId ?? "",
  ];
  return parts.join("|");
}

export function isDuplicateTitle(existingTitles: string[], candidate: string): boolean {
  const normalized = normalizeTitle(candidate);
  return existingTitles.some((t) => normalizeTitle(t) === normalized);
}
