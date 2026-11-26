import { t } from "@lingui/core/macro";
import { siteHost } from "@rakazo/core";

/** The destination line a credential request card shows beneath its prompt. */
export function secretDestinationLabel(credential: {
  origin: string;
  auth: { type: string };
}): string {
  if (credential.auth.type === "command") return "";
  if (credential.auth.type === "login") return siteHost(credential.origin);
  if (credential.auth.type === "card") return t`Card`;
  if (credential.auth.type === "contact") return t`Contact`;
  return credential.origin;
}
