import { commandVariableName } from "@rakazo/contracts";
import { t } from "./i18n";

/**
 * The destination line a credential request card shows beneath its prompt. A command variable has
 * no site, so it shows the environment variable name the bot's shell commands receive instead of
 * an empty origin; every other credential type shows its saved site.
 */
export function secretDestinationLabel(credential: {
  name: string;
  origin: string;
  auth: { type: string };
}): string {
  if (credential.auth.type === "command") {
    return `${t("Command variable")} · $${commandVariableName(credential.name)}`;
  }
  return credential.origin;
}
