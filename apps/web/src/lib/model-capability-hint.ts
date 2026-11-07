import { t } from "@lingui/core/macro";
import type { OpenAiCompatibleModelInfo } from "@rakazo/contracts";

/** Short capability hints for a discovered model, such as "Images · Thinking". */
export function modelCapabilityHint(info: OpenAiCompatibleModelInfo | undefined): string {
  if (!info) return "";
  return [info.supportsImages ? t`Images` : "", info.reasoning ? t`Thinking` : ""]
    .filter(Boolean)
    .join(" · ");
}
