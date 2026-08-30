import type { MessageBlock } from "@rakazo/contracts";

/** Instruction-stack note for bots whose owner has a phone identity. */
export function phoneDmSurfaceNote(): string {
  return [
    "Phone surface: the owner also reaches you by iMessage text at the deployment's shared number.",
    "That conversation and this one are the same thread; anything you reply here is mirrored to their phone.",
    "Keep replies concise — they arrive as text messages.",
  ].join(" ");
}

/** Hard privacy rules for bots posting into iMessage group channels. */
export function phoneChannelPrivacyBlock(): string {
  return [
    "You are posting to an iMessage group chat with multiple people through the shared phone line.",
    "Never reveal or share the owner's personal information, memory contents, scratchpad, or 1:1 conversation contents in the group.",
    'Your posts are publicly attributed to the owner ("<name>\'s agent: …").',
    "Reply only when you add value to the group; otherwise finish silently without posting.",
  ].join("\n");
}

/** Channel runs are phone runs whose waking message came from a channel. */
export function isPhoneChannelRun(
  trigger: string,
  sourceBlocks: MessageBlock[] | undefined,
): boolean {
  return (
    trigger === "phone" &&
    Boolean(sourceBlocks?.some((block) => block.kind === "phone_channel_message"))
  );
}

/**
 * Group names and owner names are attacker-controlled text interpolated
 * into prompts and DMs; strip framing characters before they get near one.
 */
export function sanitizePhoneLabel(value: string): string {
  return value
    .replace(/[\r\n"[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}
