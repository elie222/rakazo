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
  composerPromptSkill,
  composerSlashOptions,
  composerSlashQuery,
  mentionChipKey,
  pickComposerSlashSkill,
  removeComposerSlashQuery,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useId, useMemo, useState } from "react";

/** Mention and slash editing decisions; the composer owns persisted draft state. */
export function useComposerTriggers({
  draft,
  mentionBindings,
  selectedMentions,
  mentionTargets,
  agentSkills,
  selectedSkill,
  selectedSkillRef,
  setSelectedSkill,
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
  selectedSkill: AgentSkillCatalogEntry | null;
  selectedSkillRef: RefObject<AgentSkillCatalogEntry | null>;
  setSelectedSkill: (skill: AgentSkillCatalogEntry | null, persist?: boolean) => void;
  getField: () => HTMLTextAreaElement | null;
  pendingCaret: RefObject<ComposerMentionRange | null>;
  markEdited: () => void;
  commitComposition: (next: { text: string; bindings: ComposerMentionBinding[] }) => void;
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const knownMentions = [...(mentionTargets ?? []), ...selectedMentions];
  const mentionListboxId = useId();
  const slashListboxId = useId();
  const [mentionQuery, setMentionQuery] = useState<string | null>(
    () =>
      composerMentionQuery(draft, draft.length, draft.length, mentionTargets, mentionBindings)
        ?.query ?? null,
  );
  const [mentionHighlightKey, setMentionHighlightKey] = useState<string | null>(null);
  // The range is kept, so a pick edits the query that opened the menu wherever the caret is now.
  const [slashQuery, setSlashQuery] = useState<ComposerMentionQuery | null>(() =>
    composerPromptSkill(selectedSkill, mentionBindings)
      ? null
      : composerSlashQuery(draft, draft.length, draft.length, mentionBindings),
  );
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
    // One skill per message: a chosen skill, chip or inline, keeps the menu closed.
    const next = composerPromptSkill(selectedSkillRef.current, bindings)
      ? null
      : composerSlashQuery(value, start, end, bindings);
    const options = next ? composerSlashOptions(next, agentSkills ?? []) : null;
    const opensMenu = options !== null && (options.skills.length > 0 || options.actions.length > 0);
    // A leading slash refreshes even an empty catalogue. Mid-message candidates
    // refresh only when they actually open the picker, not for prose paths.
    if (next && ((next.start === 0 && slashQuery === null) || (opensMenu && !showSlashPicker)))
      onSlashOpen?.();
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

  function insertSkill(skill: AgentSkillCatalogEntry) {
    if (!slashQuery) return;
    markEdited();
    setSlashQuery(null);
    const pick = pickComposerSlashSkill(draft, slashQuery, skill, mentionBindings);
    if (pick.chip) setSelectedSkill(pick.chip);
    commitComposition({ text: pick.text, bindings: pick.bindings });
    pendingCaret.current = { start: pick.caret, end: pick.caret };
  }

  function runSlashAction(action: SlashActionId) {
    if (!slashQuery) return;
    markEdited();
    const removed = removeComposerSlashQuery(draft, slashQuery, mentionBindings);
    commitComposition({ text: removed.text, bindings: removed.bindings });
    setSlashQuery(null);
    pendingCaret.current = { start: removed.caret, end: removed.caret };
    onSlashAction?.(action);
  }

  function removeSkill() {
    markEdited();
    setSelectedSkill(null, true);
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
        : composerSlashOptions(slashQuery, agentSkills ?? []),
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
