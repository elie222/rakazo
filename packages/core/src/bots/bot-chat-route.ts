const RESERVED_APP_SEGMENTS = new Set(["artifacts", "board", "g", "x"]);

export function isReservedAppSegment(segment: string): boolean {
  return RESERVED_APP_SEGMENTS.has(segment);
}

/** IDs allowed in externally opened bot chat routes. */
export function isBotChatRouteId(id: string): boolean {
  return id.length >= 1 && id.length <= 200 && !/[^A-Za-z0-9_-]/.test(id);
}
