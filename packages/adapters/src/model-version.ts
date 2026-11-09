/**
 * Order dotted model versions ("4.5", "5", "4.0.8") segment by segment. A missing segment ranks
 * below an explicit one, so "5" sorts before "5.0".
 */
export function compareVersions(left: string | undefined, right: string | undefined): number {
  const a = (left ?? "").split(".").map(Number);
  const b = (right ?? "").split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff) return diff;
  }
  return 0;
}
