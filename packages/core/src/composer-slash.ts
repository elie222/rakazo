import type { ComposerMentionBinding } from "./composer-mention-bindings.js";
import { composerPromptSkill } from "./composer-mention-bindings.js";
import type { ComposerMentionQuery, ComposerMentionRange } from "./composer-mentions.js";

export const SLASH_ACTIONS = [
  { id: "chat-settings" as const, label: "Chat Settings" },
  { id: "settings-general" as const, label: "Settings: General" },
  { id: "settings-usage" as const, label: "Settings: Usage" },
] as const;

export type SlashActionId = (typeof SLASH_ACTIONS)[number]["id"];

/** Keep inline mentions and skills in the draft; the message's skill also adds a prefix. */
export function serializeComposerPrompt(
  draft: string,
  chip: { name: string } | null,
  bindings: readonly ComposerMentionBinding[] = [],
): string {
  const skill = composerPromptSkill(chip, bindings);
  const body = draft.replace(/^\s+/, "");
  if (!skill) return body.trimEnd();
  return body.trim().length > 0 ? `/${skill.name}\n${body}` : `/${skill.name}`;
}

export function truncateSlashDescription(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * The `/query` before a collapsed caret: a `/` at the start or after whitespace on the caret's
 * line, so paths and URLs never open the menu, and never one inside bound text (a picked skill).
 * Mid-message a non-space must follow the `/`, so "yes / no" and "is it 1 /" stay prose. With only
 * whitespace before the `/`, the query starts at 0, since that is the start of the sent message.
 */
export function composerSlashQuery(
  text: string,
  selectionStart = text.length,
  selectionEnd = selectionStart,
  bindings: readonly ComposerMentionRange[] = [],
): ComposerMentionQuery | null {
  if (selectionStart !== selectionEnd) return null;
  if (/^[\p{L}\p{N}_-]/u.test(text.slice(selectionStart))) return null;
  for (let slash = selectionStart - 1; slash >= 0 && text[slash] !== "\n"; slash--) {
    if (text[slash] !== "/" || (slash > 0 && !/\s/.test(text[slash - 1]!))) continue;
    if (bindings.some((binding) => slash >= binding.start && slash < binding.end)) return null;
    const query = text.slice(slash + 1, selectionStart);
    const start = text.slice(0, slash).trim() ? slash : 0;
    if (start ? !/^\S/.test(query) : /^\s/.test(query)) return null;
    return { start, end: selectionStart, query };
  }
  return null;
}
