import type { ModelAccountConfig } from "@rakazo/contracts";

/** Cookie values are preferences, never a source of trusted navigation destinations. */
export function resolveAccountNavigation(config: ModelAccountConfig, cookies = "", hostname = "") {
  if (!config.enabled || !config.navigation) return undefined;
  const policy = config.navigation;
  const dedicated = policy.productHosts.some((host) => hostname.endsWith(`.${host}`));
  const values = cookies
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.split("=", 1)[0] === policy.cookieName);
  if (values.length === 1) {
    try {
      const value = JSON.parse(decodeURIComponent(values[0]!.slice(policy.cookieName.length + 1)));
      const channel = policy.channels.find(
        (entry) =>
          value.v === 1 &&
          entry.channel === value.channel &&
          entry.homeUrl === value.homeUrl &&
          entry.rechargeUrl === value.rechargeUrl,
      );
      if (
        channel &&
        (!dedicated ||
          policy.productHosts.some((host) => hostname === `${channel.channel}.${host}`))
      )
        return channel;
    } catch {
      /* Invalid preferences fall back to platform defaults on public hosts. */
    }
  }
  return dedicated ? undefined : policy.defaults;
}
