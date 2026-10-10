/** Retain unchanged JSON response branches, including rows moved within an ID-keyed list. */
export function retainInboxValue<T>(current: T, next: T): T {
  if (current === next) return current;
  if (Array.isArray(current) && Array.isArray(next)) {
    const byId = new Map(current.filter(hasId).map((item) => [item.id, item]));
    const retained = next.map((item, index) =>
      retainInboxValue(hasId(item) ? byId.get(item.id) : current[index], item),
    );
    return (
      current.length === retained.length && retained.every((item, index) => item === current[index])
        ? current
        : retained
    ) as T;
  }
  if (isRecord(current) && isRecord(next)) {
    const keys = Object.keys(next);
    const retained = Object.fromEntries(
      keys.map((key) => [key, retainInboxValue(current[key], next[key])]),
    );
    return (
      Object.keys(current).length === keys.length &&
      keys.every((key) => Object.hasOwn(current, key) && retained[key] === current[key])
        ? current
        : retained
    ) as T;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string";
}
