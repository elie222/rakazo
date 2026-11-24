import { t } from "@lingui/core/macro";
import { ALWAYS_ALLOW_BATCH_LABEL } from "@rakazo/contracts";

export function alwaysAllowActionLabel(label: string, site?: string): string {
  if (site) return t`Always allow ${site}`;
  if (label === ALWAYS_ALLOW_BATCH_LABEL) return t`Always allow these tools`;
  return t`Always allow this tool`;
}
