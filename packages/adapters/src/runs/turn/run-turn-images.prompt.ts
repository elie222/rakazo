import type { MessageBlock } from "@rakazo/contracts";

export const TURN_ATTACHMENT_UNAVAILABLE =
  "An attachment in this message could not be loaded. Tell the user the attachment was unavailable and do not guess its contents.";

export const STEERING_ATTACHMENT_UNAVAILABLE = TURN_ATTACHMENT_UNAVAILABLE;

export function missingTurnImagesInstruction(
  blocks: MessageBlock[] | undefined,
  images: { length: number } | undefined,
): string {
  const expected = blocks?.filter((block) => block.kind === "image").length ?? 0;
  const loaded = images?.length ?? 0;
  return expected > 0 && loaded < expected ? TURN_ATTACHMENT_UNAVAILABLE : "";
}

export function unavailableImageMarker(name: string): string {
  return `[image: ${name} (unavailable)]`;
}
