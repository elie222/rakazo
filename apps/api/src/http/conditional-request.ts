/** Tests a GET or HEAD validator against the resource's strong ETag. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  // Quoted tags may contain commas. Weak tags compare equal for cache revalidation.
  const tags = header.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g);
  return Array.from(tags).some(([, tag]) => tag === etag);
}
