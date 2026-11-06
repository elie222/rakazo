import { t } from "@lingui/core/macro";
import type { OpenAiCompatibleModelInfo, OpenAiCompatiblePreset } from "@rakazo/contracts";

/** Placeholder for the API key field of a hosted preset; undefined for an ordinary server. */
export function presetApiKeyPlaceholder(
  preset: Pick<OpenAiCompatiblePreset, "name"> | undefined,
): string | undefined {
  if (!preset) return undefined;
  const provider = preset.name;
  return t`API key for ${provider}`;
}

/** Short capability hints for a discovered model, such as "Images · Thinking". */
export function modelCapabilityHint(info: OpenAiCompatibleModelInfo | undefined): string {
  if (!info) return "";
  return [info.supportsImages ? t`Images` : "", info.reasoning ? t`Thinking` : ""]
    .filter(Boolean)
    .join(" · ");
}
