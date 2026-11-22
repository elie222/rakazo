import { t } from "@lingui/core/macro";
import { commandVariableName } from "@rakazo/contracts";
import { siteHost } from "@rakazo/core";

/**
 * The destination line a credential request card shows beneath its prompt. A command variable has
 * no site, so it shows the environment variable name the bot's shell commands receive instead of
 * an empty origin; logins show the host, cards and contacts their kind, and other credential types
 * show their saved site.
 */
export function secretDestinationLabel(credential: {
  name: string;
  origin: string;
  auth: { type: string };
}): string {
  if (credential.auth.type === "command") {
    return `${t`Command variable`} $${commandVariableName(credential.name)}`;
  }
  if (credential.auth.type === "login") return siteHost(credential.origin);
  if (credential.auth.type === "card") return t`Card`;
  if (credential.auth.type === "contact") return t`Contact`;
  return credential.origin;
}
