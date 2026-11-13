import type { OpenAiCompatibleModelInfo } from "@rakazo/contracts";

/**
 * Short capability hints for a discovered model, such as "Images · Thinking", in the caller's
 * translated words. Empty when the listing does not describe the model or it has neither.
 */
export function modelCapabilityHint(
  info: Pick<OpenAiCompatibleModelInfo, "supportsImages" | "reasoning"> | undefined,
  labels: { images: string; thinking: string },
): string {
  if (!info) return "";
  return [info.supportsImages ? labels.images : "", info.reasoning ? labels.thinking : ""]
    .filter(Boolean)
    .join(" · ");
}
