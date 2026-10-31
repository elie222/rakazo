import { commandVariableName } from "@rakazo/contracts";
import { t } from "./i18n";

/** The host a site card shows, or the origin when it does not parse. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * The destination line a credential request card shows beneath its prompt. A command variable has
 * no site, so it shows the environment variable name the bot's shell commands receive instead of
 * an empty origin; logins show the host and other credential types show their saved site.
 */
export function secretDestinationLabel(credential: {
  name: string;
  origin: string;
  auth: { type: string };
}): string {
  if (credential.auth.type === "command") {
    return `${t("Command variable")} $${commandVariableName(credential.name)}`;
  }
  if (credential.auth.type === "login") return siteHost(credential.origin);
  return credential.origin;
}
