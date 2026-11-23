import { t } from "@lingui/core/macro";
import type { ApprovalMode } from "@rakazo/contracts";

/** "space" is a bot following its Space's approval mode. */
export type ApprovalModeChoice = ApprovalMode | "space";

export function approvalModeLabel(mode: ApprovalModeChoice): string {
  if (mode === "space") return t`Space default`;
  if (mode === "ask") return t`Ask`;
  if (mode === "auto") return t`Auto`;
  return t`Never ask`;
}
