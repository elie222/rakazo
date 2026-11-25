import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type {
  buildComposerMentionOptions,
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
  composerMentionSegments,
  composerMentionsForPrompt,
  composerSelectedMentions,
  composerSlashOptions,
  composerSlashQuery,
  filterComposerMentionTargets,
  removeComposerSlashQuery,
  resolveComposerMentionBackspace,
  resolveComposerMentionEdit,
  resolveMentionPickerKey,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ScrollViewInstance, TextInputInstance, ViewStyle } from "react-native";
import {
  AppState,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useComposerDictation } from "../../lib/composer/composer-dictation";
import type { ComposerDraftScope } from "../../lib/composer/composer-draft";
import { readComposerDraft, writeComposerDraft } from "../../lib/composer/composer-draft";
import { useComposerHardwareEnterPreference } from "../../lib/composer/composer-enter-to-send-preference";
import type { ComposerModel } from "../../lib/composer/composer-model";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native/native";
import type { ComposerSnapshot } from "../../lib/thread/send/thread-feedback";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";
import { ComposerKeyboard } from "./composer-keyboard";
import { ComposerMentionPicker } from "./composer-mention-picker";
import { ModelChip, TrailingControls } from "./composer-model-chip";
import { DictationBar } from "./dictation-bar";

type NativeEdit = {
  beforeText: string;
  afterText: string;
  bindings: ComposerMentionBinding[];
  beforeSelections: ComposerMentionRange[];
  /** Start of the mention that was selected when the edit began. */
  selectedMention: number | null;
};

export type ThreadComposerHandle = {
  snapshot: () => ComposerSnapshot;
  reset: () => void;
  insert: (text: string) => void;
  /** A page's reply, added on the same line as the web composer does. */
  addReply: (text: string) => void;
};

const DRAFT_SAVE_DELAY_MS = 500;
const MENTION_PICKER_MAX_ROWS = 5;

function samePickerQuery(first: ComposerMentionQuery | null, second: ComposerMentionQuery | null) {
  return (
    first?.start === second?.start && first?.end === second?.end && first?.query === second?.query
  );
}

type ThreadComposerProps = {
  ref: Ref<ThreadComposerHandle>;
  /** Where the unsent text is kept; without it the draft lives only while mounted. */
  draftScope?: ComposerDraftScope;
  onMentionRequested?: () => void;
  agentSkills: AgentSkillCatalogEntry[];
  composerMentionTargets: ReturnType<typeof buildComposerMentionOptions>;
  composerPrompt: string;
  replyTargetId?: string;
  replyQuote: string | null;
  attachmentIds: string[];
  botId?: string;
  onCall: boolean;
  sending: boolean;
  styles: { composerFill: ViewStyle };
  attachActions: MenuAction[];
  attachFrom: (source: string) => void;
  send: () => Promise<void>;
  startVoiceCall: () => Promise<void>;
  onSlashAction: (action: SlashActionId) => void;
  /** The composer holds no text: the last of it was deleted or sent. */
  onEmptied?: () => void;
  /** The chat's model, shown in the box when the person turned the model picker on. */
  model?: ComposerModel;
};

export function ThreadComposer({
  ref,
  draftScope,
  onMentionRequested,
  agentSkills,
  composerMentionTargets,
  composerPrompt,
  replyTargetId,
  replyQuote,
  attachmentIds,
  botId,
  onCall,
  sending,
  styles,
  attachActions,
  attachFrom,
  send,
  startVoiceCall,
  onSlashAction,
  onEmptied,
  model,
}: ThreadComposerProps) {
  const tokens = useMobileTokens();
  // A mention is plain text in the link blue; it turns bold while a backspace has it selected.
  const mentionStyle = (selected: boolean) => ({
    color: tokens.link,
    fontWeight: selected ? ("bold" as const) : undefined,
  });
  const { fontScale } = useWindowDimensions();
  // The input text stops growing at MAX_FONT_SCALE, so its height limits stop there too.
  const textScale = Math.min(fontScale, MAX_FONT_SCALE);
  const colorScheme = useResolvedAppearance();
  const { t } = useLingui();
  const inputRef = useRef<TextInputInstance>(null);
  const [saved] = useState(() => readComposerDraft(draftScope));
  const [draft, setDraft] = useState(saved.text);
  const [emptyRowHeight, setEmptyRowHeight] = useState<number>();
  // Text past one line moves the model, dictation and send to a row under it until the box empties.
  const [wrapped, setWrapped] = useState(false);
  const draftRef = useRef(saved.text);
  const nativeSelection = useRef({ start: saved.text.length, end: saved.text.length });
  const completedSelection = useRef<number | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [mentionQuery, setMentionQuery] = useState<ComposerMentionQuery | null>(null);
  const [slashQuery, setSlashQuery] = useState<ComposerMentionQuery | null>(null);
  const [mentionBindings, setMentionBindings] = useState(saved.bindings);
  const bindingsRef = useRef(saved.bindings);
  const selectionHistory = useRef<ComposerMentionRange[]>([]);
  const pendingNativeEdit = useRef<NativeEdit | null>(null);
  const [selectedMention, setSelectedMention] = useState<number | null>(null);
  const selectedMentionRef = useRef<number | null>(null);
  function selectMention(start: number | null) {
    selectedMentionRef.current = start;
    setSelectedMention(start);
  }
  function updateBindings(next: ComposerMentionBinding[]) {
    bindingsRef.current = next;
    setMentionBindings(next);
  }
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  // Dictated words follow the text that was there when the mic opened. Once someone edits the
  // box meanwhile, later words are dropped instead of overwriting the edit.
  const dictatedBase = useRef<string | null>(null);
  const dictated = useRef("");
  function showDictation(words: string, final = false) {
    let base = dictatedBase.current;
    if (base === null) return;
    // Live words never overwrite an edit; a provider's one-off transcript joins the edited text.
    if (draftRef.current !== dictated.current) {
      if (!final) return;
      base = draftRef.current;
    }
    const next = !words ? base : base.trim() ? `${base.trimEnd()} ${words}` : words;
    dictated.current = next;
    draftRef.current = next;
    setDraft(next);
    const end = next.length;
    pendingNativeEdit.current = null;
    nativeSelection.current = { start: end, end };
    selectionHistory.current = [nativeSelection.current];
    completedSelection.current = null;
    setSelection(nativeSelection.current);
    setMentionQuery(null);
    setSlashQuery(null);
  }
  const dictation = useComposerDictation({ disabled: onCall, onWords: showDictation });
  const recording = dictation.status !== "idle";
  function toggleDictation() {
    if (dictation.status === "idle") {
      dictatedBase.current = draftRef.current;
      dictated.current = draftRef.current;
    }
    dictation.toggle();
  }
  /** Drops the recording and any words it already put in the box. */
  function discardDictation() {
    const base = dictatedBase.current;
    dictation.cancel();
    if (base !== null && draftRef.current === dictated.current) showDictation("");
    dictatedBase.current = null;
  }
  // Send during dictation stops it first and sends once its words are in.
  const [sendAfterDictation, setSendAfterDictation] = useState(false);
  function sendOrFinish() {
    if (recording) dictation.finish(() => setSendAfterDictation(true));
    else void send();
  }
  // Saving waits for a pause in typing; closing the conversation or leaving the app saves at once.
  // Set while the composer holds text that storage does not have yet.
  const pendingSave = useRef<(() => boolean) | null>(null);
  function flushDraftSave() {
    // A failed save stays pending, so the next flush retries it.
    if (pendingSave.current?.()) pendingSave.current = null;
  }
  useEffect(() => {
    if (!draftScope) return;
    pendingSave.current = () => writeComposerDraft(draftScope, draft, mentionBindings);
    // An emptied composer, such as after a send, forgets the draft right away.
    if (!draft) flushDraftSave();
  }, [draftScope, draft, mentionBindings]);
  // Each edit starts the pause again.
  const draftEdit = useMemo(() => ({}), [draftScope, draft, mentionBindings]);
  useTimeout(flushDraftSave, draftScope && draft ? DRAFT_SAVE_DELAY_MS : null, draftEdit);
  useEffect(() => {
    if (!draft) onEmptied?.();
  }, [draft, onEmptied]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flushDraftSave();
    });
    return () => {
      subscription.remove();
      flushDraftSave();
    };
  }, []);
  useImperativeHandle(ref, () => ({
    snapshot: () => ({
      promptText: serializeComposerPrompt(draft, selectedSkill),
      mentions: composerMentionsForPrompt(draft, selectedSkill, mentionBindings),
      skill: selectedSkill,
      replyTargetId,
      replyQuote,
      attachmentIds,
    }),
    reset: () => {
      dictation.cancel();
      // Empty the native field as well. It measures its height from the text it last reported,
      // so clearing only the draft would leave it as tall as the message just sent.
      inputRef.current?.clear();
      draftRef.current = "";
      setDraft("");
      setWrapped(false);
      nativeSelection.current = { start: 0, end: 0 };
      completedSelection.current = null;
      setSelection({ start: 0, end: 0 });
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      updateBindings([]);
      selectMention(null);
      selectionHistory.current = [];
      pendingNativeEdit.current = null;
    },
    insert: (text) => {
      setSlashQuery(null);
      setMentionQuery(null);
      // A delayed selection must not replay the edit from before the share.
      pendingNativeEdit.current = null;
      const current = draftRef.current;
      draftRef.current = current ? `${current}\n${text}` : text;
      setDraft(draftRef.current);
    },
    addReply: (text) => {
      setSlashQuery(null);
      setMentionQuery(null);
      const current = draftRef.current;
      draftRef.current = current.trim() ? `${current.trimEnd()} ${text}` : text;
      setDraft(draftRef.current);
      // Typing continues after the reply, not where the caret was left earlier.
      const end = draftRef.current.length;
      pendingNativeEdit.current = null;
      nativeSelection.current = { start: end, end };
      selectionHistory.current = [nativeSelection.current];
      completedSelection.current = null;
      setSelection(nativeSelection.current);
    },
  }));
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    return filterComposerMentionTargets(composerMentionTargets, mentionQuery.query).slice(
      0,
      MENTION_PICKER_MAX_ROWS,
    );
  }, [composerMentionTargets, mentionQuery]);
  function slashActionLabel(id: SlashActionId) {
    switch (id) {
      case "chat-settings":
        return t`Chat Settings`;
      case "settings-general":
        return t`Settings: General`;
      case "settings-usage":
        return t`Settings: Usage`;
    }
  }
  const { skills: slashSkillOptions, actions: slashActionOptions } =
    slashQuery !== null && mentionQuery === null
      ? composerSlashOptions(slashQuery, agentSkills, (action) => slashActionLabel(action.id))
      : { skills: [], actions: [] };
  const pickerScroll = useRef<ScrollViewInstance>(null);
  const pickerRowOffsets = useRef<number[]>([]);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const optionCount = mentionOptions.length || slashSkillOptions.length + slashActionOptions.length;
  const activePickerIndex =
    pickerIndex === null ? null : clampMentionHighlightIndex(pickerIndex, optionCount);

  function updatePickerQueries(value: string, start: number, end = start) {
    // One skill per message: a chosen skill keeps the slash menu closed.
    const nextSlash = selectedSkill
      ? null
      : composerSlashQuery(value, start, end, bindingsRef.current);
    // A mention selected by a backspace is waiting to be deleted, not re-picked.
    const nextMention =
      selectedMentionRef.current !== null
        ? null
        : composerMentionQuery(
            value,
            start,
            end,
            [...composerMentionTargets, ...composerSelectedMentions(bindingsRef.current)],
            bindingsRef.current,
          );
    if (!samePickerQuery(mentionQuery, nextMention) || !samePickerQuery(slashQuery, nextSlash)) {
      setPickerIndex(null);
    }
    if (nextMention) onMentionRequested?.();
    setSlashQuery(nextSlash);
    setMentionQuery(nextMention);
  }

  function updateDraft(nativeValue: string) {
    // Native text changes can arrive before their selection event. Infer the end
    // of the changed span so the picker never reads the previous caret position.
    const previous = draftRef.current;
    // The native input can report the text it already shows again, for instance after the
    // composer moved its caret. That is no edit, and the caret it implies would be the end.
    if (nativeValue === previous) return;
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < nativeValue.length &&
      previous[prefix] === nativeValue[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < nativeValue.length - prefix &&
      previous[previous.length - suffix - 1] === nativeValue[nativeValue.length - suffix - 1]
    ) {
      suffix += 1;
    }
    const edit = {
      beforeText: previous,
      afterText: nativeValue,
      bindings: bindingsRef.current,
      beforeSelections: [nativeSelection.current, ...selectionHistory.current.toReversed()],
      selectedMention: selectedMentionRef.current,
    };
    pendingNativeEdit.current = edit;
    selectionHistory.current = [];
    const { text: value, caret: widenedCaret } = applyNativeEdit(edit, nativeSelection.current);
    const caret = widenedCaret ?? nativeValue.length - suffix;
    if (widenedCaret !== null) nativeSelection.current = { start: caret, end: caret };
    setSelection(widenedCaret === null ? undefined : nativeSelection.current);
    updatePickerQueries(value, caret);
  }

  function applyNativeEdit(edit: NativeEdit, after: ComposerMentionRange) {
    const hints = { before: edit.beforeSelections, after };
    const resolved = resolveComposerMentionBackspace(
      edit.beforeText,
      edit.afterText,
      edit.bindings,
      hints,
      edit.selectedMention,
    ) ?? {
      ...resolveComposerMentionEdit(edit.beforeText, edit.afterText, edit.bindings, hints),
      selected: null,
    };
    selectMention(resolved.selected);
    updateBindings(resolved.bindings);
    draftRef.current = resolved.text;
    setDraft(resolved.text);
    // An emptied box goes back to one row even when its height did not change on the way.
    if (!resolved.text) setWrapped(false);
    completedSelection.current = null;
    return resolved;
  }

  function insertMention(mention: ComposerMention) {
    if (!mentionQuery) return;
    const next = bindComposerMention(draftRef.current, mentionQuery, mention, bindingsRef.current);
    pendingNativeEdit.current = null;
    updateBindings(next.bindings);
    selectMention(null);
    draftRef.current = next.text;
    setDraft(next.text);
    nativeSelection.current = { start: next.caret, end: next.caret };
    selectionHistory.current = [nativeSelection.current];
    completedSelection.current = next.caret;
    setSelection(nativeSelection.current);
    setMentionQuery(null);
    inputRef.current?.focus();
  }

  /** Takes the `/query` out of the draft, keeping the words and mentions around it. */
  function removeSlashQuery(): boolean {
    if (!slashQuery) return false;
    const next = removeComposerSlashQuery(draftRef.current, slashQuery, bindingsRef.current);
    draftRef.current = next.text;
    setDraft(next.text);
    nativeSelection.current = { start: next.caret, end: next.caret };
    completedSelection.current = null;
    setSelection(nativeSelection.current);
    updateBindings(next.bindings);
    selectMention(null);
    selectionHistory.current = [];
    pendingNativeEdit.current = null;
    setSlashQuery(null);
    return true;
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    if (removeSlashQuery()) setSelectedSkill(skill);
  }

  function runSlashAction(action: SlashActionId) {
    if (removeSlashQuery()) onSlashAction(action);
  }

  const composerPillStyle = {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  // Each control keeps the 44-point tap target iOS asks for around its 32-point circle.
  const pillHitSlop = (44 - composerPillStyle.width) / 2;

  // One line of text with its padding, as measured while the box is empty. The pills and attach
  // button centre on it: the bar can grow past 44 (font scale, Android text metrics), and a fixed
  // bottom margin would leave them high.
  const lineHeight = Math.max(44, emptyRowHeight ?? 22 + 22 * textScale);
  // While dictating, the recording controls take a row under the text.
  const stacked = recording || (Boolean(model) && wrapped);
  // Lines the controls up with a single line of text; under the text they center on each other.
  const pillInset = stacked ? 0 : (lineHeight - composerPillStyle.height) / 2;

  const canSend = Boolean(draft.trim()) || selectedSkill !== null || attachmentIds.length > 0;
  useEffect(() => {
    if (!sendAfterDictation || recording) return;
    setSendAfterDictation(false);
    if (canSend) void send();
  }, [sendAfterDictation, recording]);
  // Sending resets the box, so words still being transcribed wait; send while the mic is open
  // stops it and sends once its words are in.
  const sendBlocked =
    sending ||
    sendAfterDictation ||
    dictation.status === "transcribing" ||
    (!canSend && dictation.status === "idle");

  const enterToSend = useComposerHardwareEnterPreference();
  function onHardwareKey(key: string) {
    const action = resolveMentionPickerKey({
      key: key === "CommandEnter" ? "Enter" : key,
      metaKey: key === "CommandEnter",
      optionCount,
      highlightedIndex: activePickerIndex ?? (key === "ArrowDown" ? optionCount - 1 : 0),
      enterToSend,
    });
    switch (action.type) {
      case "complete": {
        const mention = mentionOptions[action.index];
        const skill = slashSkillOptions[action.index];
        const slashAction = slashActionOptions[action.index - slashSkillOptions.length];
        if (mention) insertMention(mention);
        else if (skill) insertSkill(skill);
        else if (slashAction) runSlashAction(slashAction.id);
        break;
      }
      case "move":
        setPickerIndex(action.index);
        pickerScroll.current?.scrollTo({ y: pickerRowOffsets.current[action.index] ?? 0 });
        break;
      case "dismiss":
        completedSelection.current = nativeSelection.current.start;
        setMentionQuery(null);
        setSlashQuery(null);
        break;
      case "send":
        if (!sendBlocked) sendOrFinish();
        break;
    }
  }

  const sendButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t`Send`}
      disabled={sendBlocked}
      hitSlop={pillHitSlop}
      onPress={sendOrFinish}
      style={{ marginBottom: pillInset, opacity: sendBlocked ? 0.5 : 1 }}
    >
      <GlassSurface
        tint={tokens.primary}
        style={composerPillStyle}
        fallbackStyle={{ backgroundColor: tokens.primary }}
      >
        <NativeSymbol
          ios="arrow.up"
          android="arrow-up"
          size={15}
          color={tokens.primaryForeground}
        />
      </GlassSurface>
    </Pressable>
  );

  return (
    <>
      {mentionOptions.length ? (
        <ComposerMentionPicker
          mentions={mentionOptions}
          scrollRef={pickerScroll}
          highlightedIndex={activePickerIndex}
          onRowLayout={(index, y) => {
            pickerRowOffsets.current[index] = y;
          }}
          onPick={insertMention}
        />
      ) : null}
      {slashSkillOptions.length || slashActionOptions.length ? (
        <ScrollView
          ref={pickerScroll}
          testID="slash-picker"
          keyboardShouldPersistTaps="handled"
          style={{
            flexGrow: 0,
            flexShrink: 1,
            marginTop: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            overflow: "hidden",
          }}
        >
          {slashSkillOptions.map((skill, index) => (
            <Pressable
              accessibilityRole="button"
              key={skill.id}
              accessibilityLabel={t`Skill ${ph({ name: skill.name })}`}
              onPress={() => insertSkill(skill)}
              accessibilityState={{ selected: index === activePickerIndex }}
              onLayout={(event) => {
                pickerRowOffsets.current[index] = event.nativeEvent.layout.y;
              }}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: index === activePickerIndex ? tokens.muted : undefined,
              }}
            >
              <NativeSymbol
                ios="cube"
                android="cube-outline"
                size={16}
                color={tokens.mutedForeground}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{skill.name}</Text>
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 2 }}
                >
                  {truncateSlashDescription(skill.description)}
                </Text>
              </View>
            </Pressable>
          ))}
          {slashActionOptions.map((action, index) => (
            <Pressable
              accessibilityRole="button"
              key={action.id}
              accessibilityLabel={slashActionLabel(action.id)}
              onPress={() => runSlashAction(action.id)}
              accessibilityState={{
                selected: slashSkillOptions.length + index === activePickerIndex,
              }}
              onLayout={(event) => {
                pickerRowOffsets.current[slashSkillOptions.length + index] =
                  event.nativeEvent.layout.y;
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor:
                  slashSkillOptions.length + index === activePickerIndex ? tokens.muted : undefined,
              }}
            >
              <NativeSymbol
                ios="gearshape"
                android="settings-outline"
                size={16}
                color={tokens.mutedForeground}
              />
              <Text style={{ color: tokens.foreground, fontSize: 14 }}>
                {slashActionLabel(action.id)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <GlassSurface
        shape="roundedRectangle"
        style={{
          marginTop: 8,
          minHeight: 44,
          borderRadius: 22,
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
          // Inset the round buttons as far from the edge as from the top and bottom.
          paddingStart: 6,
          paddingEnd: 6,
        }}
        fallbackStyle={styles.composerFill}
      >
        <MenuView
          actions={attachActions}
          colorScheme={colorScheme}
          onPressAction={(event) => attachFrom(event.nativeEvent.event)}
          // The native menu host sizes to its child and drops the child's margin. The menu takes
          // no hit slop, so its child is the full 44-point target, overlapping the space around it.
          style={{
            marginBottom: (stacked ? 8 : pillInset) - pillHitSlop,
            marginHorizontal: -pillHitSlop,
          }}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t`Attach file`}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <NativeSymbol ios="plus" android="add" size={20} color={tokens.foreground} />
          </View>
        </MenuView>
        <View
          style={{
            flex: 1,
            flexDirection: stacked ? "column" : "row",
            alignItems: stacked ? "stretch" : "flex-end",
            // Keeps text clear of the call/send button even when it runs to the trailing edge (RTL).
            columnGap: 12,
            rowGap: 8,
          }}
        >
          <ComposerKeyboard
            enterEnabled={enterToSend || optionCount > 0}
            commandEnterEnabled={!sendBlocked}
            pickerOpen={optionCount > 0}
            onHardwareKey={(event) => onHardwareKey(event.nativeEvent.key)}
            style={{
              flex: stacked ? undefined : 1,
              // Room for the text comes first; the model chip shrinks instead.
              minWidth: stacked ? undefined : 96,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            {selectedSkill ? (
              <View
                testID="skill-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: tokens.muted,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={13}
                  color={tokens.mutedForeground}
                />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {selectedSkill.name}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t`Remove skill ${ph({ name: selectedSkill.name })}`}
                  hitSlop={8}
                  onPress={() => {
                    setSelectedSkill(null);
                    setSlashQuery(
                      composerSlashQuery(
                        draftRef.current,
                        nativeSelection.current.start,
                        nativeSelection.current.end,
                        bindingsRef.current,
                      ),
                    );
                  }}
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ) : null}
            <Pressable
              accessible={false}
              onLayout={(event) => {
                if (!draftRef.current) setEmptyRowHeight(event.nativeEvent.layout.height);
              }}
              onPress={() => inputRef.current?.focus()}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 96,
                // Keep the inset outside the scrolling native input: iOS can scroll its
                // padding out of view, leaving a partially visible line at the edge.
                paddingVertical: 11,
              }}
            >
              {!draft && !selectedSkill ? (
                <Text
                  numberOfLines={1}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                  accessible={false}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 11,
                    start: 0,
                    end: 0,
                    fontSize: 17,
                    lineHeight: 22,
                    color: tokens.faintForeground,
                  }}
                >
                  {composerPrompt}
                </Text>
              ) : null}
              <TextInput
                ref={inputRef}
                // The iOS file-drop module attaches images pasted into this field only.
                testID="chat-composer"
                onChangeText={updateDraft}
                selection={selection}
                onSelectionChange={(event) => {
                  const next = event.nativeEvent.selection;
                  const pending = pendingNativeEdit.current;
                  if (pending) {
                    pendingNativeEdit.current = null;
                    const shown = draftRef.current;
                    const resolved = applyNativeEdit(pending, next);
                    if (resolved.caret !== null || resolved.text !== shown) {
                      nativeSelection.current =
                        resolved.caret === null
                          ? next
                          : { start: resolved.caret, end: resolved.caret };
                      selectionHistory.current = [nativeSelection.current];
                      setSelection(nativeSelection.current);
                      updatePickerQueries(
                        resolved.text,
                        nativeSelection.current.start,
                        nativeSelection.current.end,
                      );
                      return;
                    }
                  }
                  selectionHistory.current = [...selectionHistory.current.slice(-3), next];
                  nativeSelection.current = next;
                  // Moving the caret out of a selected mention and its trailing space deselects it. The
                  // caret may still report the character a backspace is about to delete.
                  const selectedBinding = bindingsRef.current.find(
                    (binding) => binding.start === selectedMentionRef.current,
                  );
                  if (
                    selectedBinding &&
                    !(
                      next.start === next.end &&
                      next.start > selectedBinding.start &&
                      next.start <=
                        selectedBinding.end +
                          (draftRef.current[selectedBinding.end] === " " ? 1 : 0)
                    )
                  ) {
                    selectMention(null);
                  }
                  setSelection(undefined);
                  if (
                    next.start === completedSelection.current &&
                    next.end === completedSelection.current
                  ) {
                    return;
                  }
                  completedSelection.current = null;
                  updatePickerQueries(draftRef.current, next.start, next.end);
                }}
                accessibilityLabel={composerPrompt}
                onKeyPress={(event) => {
                  if (
                    event.nativeEvent.key === "Backspace" &&
                    draft.length === 0 &&
                    selectedSkill !== null
                  ) {
                    setSelectedSkill(null);
                  }
                }}
                keyboardAppearance={colorScheme}
                // Tracked even before a model chip loads, so a long restored draft stacks once it does.
                onContentSizeChange={(event) => {
                  // The stacked layout gives the text more width, so it stays until the box
                  // empties; going back as soon as the text fits would flip between the two.
                  if (event.nativeEvent.contentSize.height > 22 * textScale * 1.5) setWrapped(true);
                  else if (!draftRef.current) setWrapped(false);
                }}
                multiline
                scrollEnabled
                textAlignVertical="top"
                blurOnSubmit={false}
                style={{
                  color: tokens.foreground,
                  fontSize: 17,
                  lineHeight: 22,
                  padding: 0,
                  // Native text and lineHeight scale with Dynamic Type; the viewport must too.
                  minHeight: 22 * textScale,
                  maxHeight: 110 * textScale,
                  writingDirection: "auto",
                }}
              >
                {composerMentionSegments(draft, mentionBindings).map((segment, index) => (
                  <Text
                    key={index}
                    style={
                      segment.binding
                        ? mentionStyle(segment.binding.start === selectedMention)
                        : undefined
                    }
                  >
                    {segment.text}
                  </Text>
                ))}
              </TextInput>
            </Pressable>
          </ComposerKeyboard>
          {dictation.status !== "idle" ? (
            <DictationBar
              status={dictation.status}
              onLevel={dictation.onLevel}
              onCancel={discardDictation}
              onStop={toggleDictation}
              pillStyle={composerPillStyle}
            >
              {sendButton}
            </DictationBar>
          ) : (
            <TrailingControls stacked={stacked}>
              {model ? (
                <ModelChip
                  model={model}
                  // A mark beside the text; its name and thinking once the controls sit under it.
                  full={stacked}
                  style={{ marginBottom: pillInset }}
                />
              ) : null}
              {onCall ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t`Dictate`}
                  hitSlop={pillHitSlop}
                  onPress={toggleDictation}
                  style={{ marginBottom: pillInset }}
                >
                  <View style={composerPillStyle}>
                    <NativeSymbol
                      ios="mic"
                      android="mic-outline"
                      size={18}
                      color={tokens.foreground}
                    />
                  </View>
                </Pressable>
              )}
              {!canSend && botId && !onCall ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t`Call`}
                  hitSlop={pillHitSlop}
                  onPress={() => void startVoiceCall()}
                  style={{ marginBottom: pillInset }}
                >
                  <GlassSurface
                    tint={tokens.primary}
                    style={composerPillStyle}
                    fallbackStyle={{ backgroundColor: tokens.primary }}
                  >
                    <NativeSymbol
                      ios="waveform"
                      android="pulse-outline"
                      size={15}
                      color={tokens.primaryForeground}
                    />
                  </GlassSurface>
                </Pressable>
              ) : (
                sendButton
              )}
            </TrailingControls>
          )}
        </View>
      </GlassSurface>
    </>
  );
}
