export function wouldCreateCycle(
  departments: Array<{ id: string; parentDepartmentId: string | null }>,
  targetId: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  if (newParentId === targetId) return true;
  const byId = new Map(departments.map((d) => [d.id, d.parentDepartmentId] as const));
  let cursor: string | null | undefined = newParentId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    if (cursor === targetId) return true;
    cursor = byId.get(cursor) ?? null;
  }
  return false;
}

export function validateDepartmentName(name: string): void {
  if (!name.trim() || name.trim().length > 80) throw new Error("Invalid department name");
}
