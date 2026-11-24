/**
 * Reads an on/off environment setting. Unset or blank gives the default. Anything but
 * true/false/1/0 (any case, surrounding spaces ignored) is refused, so a typo can't leave a
 * switch an operator meant to turn off still on.
 */
export function parseEnvFlag(
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
}
