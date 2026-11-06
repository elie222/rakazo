import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { AgentSkillCatalogEntrySchema } from "@rakazo/contracts";
import type { ComposerMentionBinding } from "./composer-mention-bindings.js";
import {
  bindComposerMention,
  composerPromptSkill,
  updateComposerMentionBindings,
} from "./composer-mention-bindings.js";
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
    if (start ? !/^\S+$/.test(query) : /^\s/.test(query)) return null;
    return { start, end: selectionStart, query };
  }
  return null;
}

/**
 * The rows the slash menu offers. Mid-message only skill names match, since descriptions would
 * match ordinary words, and actions stay at the start of the draft.
 */
export function composerSlashOptions<S extends { name: string; description: string }>(
  query: ComposerMentionQuery,
  skills: readonly S[],
  actionLabel: (action: (typeof SLASH_ACTIONS)[number]) => string = (action) => action.label,
) {
  const needle = query.query.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(needle);
  const atStart = query.start === 0;
  return {
    skills: skills
      .filter((skill) => !needle || matches(skill.name) || (atStart && matches(skill.description)))
      .slice(0, 8),
    actions: atStart
      ? SLASH_ACTIONS.filter(
          (action) => !needle || matches(action.label) || matches(actionLabel(action)),
        )
      : [],
  };
}

/** A saved draft's skill chip, or null when the stored value is not a skill. */
export function validateComposerDraftSkill(value: unknown): AgentSkillCatalogEntry | null {
  const parsed = AgentSkillCatalogEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The draft without its `/query`, keeping the text and mentions around it. */
export function removeComposerSlashQuery(
  text: string,
  query: ComposerMentionQuery,
  bindings: readonly ComposerMentionBinding[],
) {
  const next = text.slice(0, query.start) + text.slice(query.end);
  return {
    text: next,
    bindings: updateComposerMentionBindings(text, next, bindings, { before: [query] }),
    caret: query.start,
  };
}

/** A skill picked at the start of the draft becomes the chip; anywhere else it goes inline. */
export function pickComposerSlashSkill<S extends { id: string; name: string }>(
  text: string,
  query: ComposerMentionQuery,
  skill: S,
  bindings: readonly ComposerMentionBinding[],
): { chip: S | null; text: string; bindings: ComposerMentionBinding[]; caret: number } {
  if (query.start === 0) return { chip: skill, ...removeComposerSlashQuery(text, query, bindings) };
  const mention = { kind: "skill" as const, id: skill.id, name: skill.name };
  return { chip: null, ...bindComposerMention(text, query, mention, bindings) };
}
