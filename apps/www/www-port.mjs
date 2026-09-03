/** Shared marketing-site port for Astro + Playwright. */
export function resolveWwwPort(env = process.env) {
  const raw = env.WWW_PORT?.trim();
  if (!raw) return 4321;
  if (!/^\d+$/.test(raw)) return 4321;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 4321;
  return port;
}
