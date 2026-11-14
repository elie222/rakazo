import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type {
  ComposerMention,
  ComposerMentionBinding,
  ComposerMentionQuery,
  ComposerMentionRange,
  SlashActionId,
} from "@rakazo/core";
import {
  bindComposerMention,
  clampMentionHighlightIndex,
  composerMentionQuery,
  composerSlashOptions,
  composerSlashQuery,
  mentionChipKey,
  removeComposerSlashQuery,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { slashActionLabel } from "./composer-mentions";

type Composition = { text: string; bindings: ComposerMentionBinding[] };

/**
 * What typing `@` or `/` opens in the composer: the mention list, the slash list of skills and
 * actions, and the skill a slash pick attaches to the message.
 */
export function useComposerTriggers({
  draft,
  mentionBindings,
  selectedMentions,
  mentionTargets,
  agentSkills,
  getField,
  pendingCaret,
  markEdited,
  commitComposition,
  onSlashOpen,
  onSlashAction,
}: {
  draft: string;
  mentionBindings: ComposerMentionBinding[];
  selectedMentions: ComposerMention[];
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  /** Read when a mention is picked, for the caret it completes at. */
  getField: () => HTMLTextAreaElement | null;
  pendingCaret: RefObject<ComposerMentionRange | null>;
  markEdited: () => void;
  commitComposition: (next: Composition) => void;
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(
    () =>
      composerMentionQuery(draft, draft.length, draft.length, mentionTargets, mentionBindings)
        ?.query ?? null,
  );
  const [mentionHighlightKey, setMentionHighlightKey] = useState<string | null>(null);
  // The range is kept, so a pick edits the query that opened the menu wherever the caret is now.
  const [slashQuery, setSlashQuery] = useState<ComposerMentionQuery | null>(() =>
    composerSlashQuery(draft, draft.length, draft.length, mentionBindings),
  );
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const mentionListboxId = useId();
  const slashListboxId = useId();

  const knownMentions = [...(mentionTargets ?? []), ...selectedMentions];

  function updatePickers(
    value: string,
    caret: number,
    end: number,
    bindings: ComposerMentionBinding[],
  ) {
    setMentionQuery(
      composerMentionQuery(value, caret, end, knownMentions, bindings)?.query ?? null,
    );
    updateSlashQuery(value, caret, end, bindings);
  }

  function updateSlashQuery(
    value: string,
    start: number,
    end: number,
    bindings: typeof mentionBindings,
  ) {
    // One skill per message: a chosen skill keeps the menu closed.
    const next = selectedSkill ? null : composerSlashQuery(value, start, end, bindings);
    // Only a menu opened at the start refreshes skills, so a path typed mid-sentence never refetches.
    if (next?.start === 0 && slashQuery === null) onSlashOpen?.();
    setSlashQuery(next);
  }

  function insertMention(mention: ComposerMention) {
    const field = getField();
    if (!field) return;
    const query = composerMentionQuery(
      draft,
      field.selectionStart,
      field.selectionEnd,
      knownMentions,
      mentionBindings,
    );
    if (!query || query.query !== mentionQuery) return;
    markEdited();
    const completion = bindComposerMention(draft, query, mention, mentionBindings);
    commitComposition({ text: completion.text, bindings: completion.bindings });
    setMentionQuery(null);
    setMentionHighlightKey(null);
    // Restore after React has committed the new controlled value.
    pendingCaret.current = { start: completion.caret, end: completion.caret };
  }

  /** Takes the `/query` out of the draft, keeping the words and mentions around it. */
  function removeSlashQuery(): boolean {
    if (!slashQuery) return false;
    markEdited();
    const removed = removeComposerSlashQuery(draft, slashQuery, mentionBindings);
    commitComposition({ text: removed.text, bindings: removed.bindings });
    setSlashQuery(null);
    pendingCaret.current = { start: removed.caret, end: removed.caret };
    return true;
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    if (removeSlashQuery()) setSelectedSkill(skill);
  }

  function runSlashAction(action: SlashActionId) {
    if (removeSlashQuery()) onSlashAction?.(action);
  }

  function removeSkill() {
    markEdited();
    setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightKey(null);
  }, [mentionQuery]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionOptions.findIndex((mention) => mentionChipKey(mention) === mentionHighlightKey),
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const { skills: slashSkillOptions, actions: slashActionOptions } = useMemo(
    () =>
      slashQuery === null
        ? { skills: [], actions: [] }
        : composerSlashOptions(slashQuery, agentSkills ?? [], (action) =>
            slashActionLabel(action.id),
          ),
    [agentSkills, slashQuery],
  );

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);
  const slashOptionKeys = showSlashPicker
    ? [
        ...slashSkillOptions.map((skill) => `skill:${skill.id}`),
        ...slashActionOptions.map((action) => `action:${action.id}`),
      ]
    : [];
  const [slashHighlightKey, setSlashHighlightKey] = useState<string | null>(null);
  useEffect(() => setSlashHighlightKey(null), [slashQuery?.start, slashQuery?.query]);
  const activeSlashIndex = clampMentionHighlightIndex(
    slashOptionKeys.indexOf(slashHighlightKey ?? ""),
    slashOptionKeys.length,
  );
  const activeOptionId = mentionPickerOpen
    ? activeMentionOptionId
    : showSlashPicker
      ? `${slashListboxId}-option-${activeSlashIndex}`
      : undefined;

  function pickSlashOption(index: number) {
    const skill = slashSkillOptions[index];
    const action = slashActionOptions[index - slashSkillOptions.length];
    if (skill) insertSkill(skill);
    else if (action) runSlashAction(action.id);
  }

  return {
    knownMentions,
    setMentionQuery,
    setMentionHighlightKey,
    setSlashQuery,
    selectedSkill,
    setSelectedSkill,
    updatePickers,
    updateSlashQuery,
    insertMention,
    insertSkill,
    runSlashAction,
    removeSkill,
    mentionListboxId,
    slashListboxId,
    mentionOptions,
    activeMentionIndex,
    mentionPickerOpen,
    activeMentionOptionId,
    slashSkillOptions,
    slashActionOptions,
    showSlashPicker,
    slashOptionKeys,
    setSlashHighlightKey,
    activeSlashIndex,
    activeOptionId,
    pickSlashOption,
  };
}
