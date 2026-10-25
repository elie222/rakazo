import { commandVariableName } from "@rakazo/contracts";
import { t } from "./i18n";

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
  if (credential.auth.type === "login") {
    try {
      return new URL(credential.origin).host || credential.origin;
    } catch {
      return credential.origin;
    }
  }
  return credential.origin;
}
