import { t } from "@lingui/core/macro";
import type { OpenAiCompatibleModelInfo } from "@rakazo/contracts";
import { modelCapabilityHint as capabilityHint } from "@rakazo/core";

/** Short capability hints for a discovered model, such as "Images · Thinking". */
export function modelCapabilityHint(info: OpenAiCompatibleModelInfo | undefined): string {
  return capabilityHint(info, { images: t`Images`, thinking: t`Thinking` });
}
