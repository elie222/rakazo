import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
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
  composerMentionQuery,
  composerMentionSegments,
  composerMentionsForPrompt,
  composerSelectedMentions,
  mentionChipKey,
  resolveComposerMentionEdit,
  resolvePersonaColorDef,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ViewStyle } from "react-native";
import {
  AppState,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { ComposerDraftScope } from "../lib/composer-draft";
import { readComposerDraft, writeComposerDraft } from "../lib/composer-draft";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ComposerSnapshot } from "../lib/thread-feedback";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

type NativeEdit = {
  beforeText: string;
  afterText: string;
  bindings: ComposerMentionBinding[];
  beforeSelections: ComposerMentionRange[];
};

export type ThreadComposerHandle = {
  snapshot: () => ComposerSnapshot;
  reset: () => void;
  insert: (text: string) => void;
};

const DRAFT_SAVE_DELAY_MS = 500;

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
  working: boolean;
  sending: boolean;
  styles: { circleButton: ViewStyle; composerFill: ViewStyle };
  attachActions: MenuAction[];
  attachFrom: (source: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  startVoiceCall: () => Promise<void>;
  onSlashAction: (action: SlashActionId) => void;
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
  working,
  sending,
  styles,
  attachActions,
  attachFrom,
  send,
  stop,
  startVoiceCall,
  onSlashAction,
}: ThreadComposerProps) {
  const tokens = useMobileTokens();
  const mentionStyle = (mention: ComposerMention) => ({
    backgroundColor: tokens.muted,
    color:
      mention.kind === "bot" && mention.color
        ? resolvePersonaColorDef(mention.id, mention.color).light
        : undefined,
  });
  const { fontScale } = useWindowDimensions();
  // The input text stops growing at MAX_FONT_SCALE, so its height limits stop there too.
  const textScale = Math.min(fontScale, MAX_FONT_SCALE);
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const inputRef = useRef<TextInput>(null);
  const [saved] = useState(() => readComposerDraft(draftScope));
  const [draft, setDraft] = useState(saved.text);
  const draftRef = useRef(saved.text);
  const nativeSelection = useRef({ start: saved.text.length, end: saved.text.length });
  const completedSelection = useRef<number | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [mentionQuery, setMentionQuery] = useState<ComposerMentionQuery | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [mentionBindings, setMentionBindings] = useState(saved.bindings);
  const bindingsRef = useRef(saved.bindings);
  const selectionHistory = useRef<ComposerMentionRange[]>([]);
  const pendingNativeEdit = useRef<NativeEdit | null>(null);
  function updateBindings(next: ComposerMentionBinding[]) {
    bindingsRef.current = next;
    setMentionBindings(next);
  }
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  // Saving waits for a pause in typing; closing the conversation or leaving the app saves at once.
  // Set while the composer holds text that storage does not have yet.
  const pendingSave = useRef<(() => boolean) | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function flushDraftSave() {
    clearTimeout(saveTimer.current);
    // A failed save stays pending, so the next flush retries it.
    if (pendingSave.current?.()) pendingSave.current = null;
  }
  useEffect(() => {
    if (!draftScope) return;
    pendingSave.current = () => writeComposerDraft(draftScope, draft, mentionBindings);
    clearTimeout(saveTimer.current);
    // An emptied composer, such as after a send, forgets the draft right away.
    if (!draft) flushDraftSave();
    else saveTimer.current = setTimeout(flushDraftSave, DRAFT_SAVE_DELAY_MS);
  }, [draftScope, draft, mentionBindings]);
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
      draftRef.current = "";
      setDraft("");
      nativeSelection.current = { start: 0, end: 0 };
      completedSelection.current = null;
      setSelection({ start: 0, end: 0 });
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      updateBindings([]);
      selectionHistory.current = [];
      pendingNativeEdit.current = null;
    },
    insert: (text) => {
      const current = draftRef.current;
      draftRef.current = current ? `${current}\n${text}` : text;
      setDraft(draftRef.current);
    },
  }));
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.query.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const slashSkillOptions =
    slashQuery !== null && mentionQuery === null
      ? agentSkills
          .filter((skill) => {
            if (!slashQueryNormalized) return true;
            return (
              skill.name.toLowerCase().includes(slashQueryNormalized) ||
              skill.description.toLowerCase().includes(slashQueryNormalized)
            );
          })
          .slice(0, 8)
      : [];
  const slashActionOptions =
    slashQuery !== null && mentionQuery === null
      ? SLASH_ACTIONS.filter((action) => {
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  function updateMentionQuery(value: string, start: number, end = start) {
    const query = composerMentionQuery(
      value,
      start,
      end,
      [...composerMentionTargets, ...composerSelectedMentions(bindingsRef.current)],
      bindingsRef.current,
    );
    if (query) onMentionRequested?.();
    setMentionQuery(query);
  }

  function updateDraft(nativeValue: string) {
    // Native text changes can arrive before their selection event. Infer the end
    // of the changed span so the picker never reads the previous caret position.
    const previous = draftRef.current;
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
    };
    pendingNativeEdit.current = edit;
    selectionHistory.current = [];
    const { text: value, caret: widenedCaret } = applyNativeEdit(edit, nativeSelection.current);
    const caret = widenedCaret ?? nativeValue.length - suffix;
    if (widenedCaret !== null) nativeSelection.current = { start: caret, end: caret };
    setSelection(widenedCaret === null ? undefined : nativeSelection.current);
    updateMentionQuery(value, caret);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function applyNativeEdit(edit: NativeEdit, after: ComposerMentionRange) {
    const resolved = resolveComposerMentionEdit(edit.beforeText, edit.afterText, edit.bindings, {
      before: edit.beforeSelections,
      after,
    });
    updateBindings(resolved.bindings);
    draftRef.current = resolved.text;
    setDraft(resolved.text);
    completedSelection.current = null;
    return resolved;
  }

  function insertMention(mention: ComposerMention) {
    if (!mentionQuery) return;
    const next = bindComposerMention(draftRef.current, mentionQuery, mention, bindingsRef.current);
    pendingNativeEdit.current = null;
    updateBindings(next.bindings);
    draftRef.current = next.text;
    setDraft(next.text);
    nativeSelection.current = { start: next.caret, end: next.caret };
    selectionHistory.current = [nativeSelection.current];
    completedSelection.current = next.caret;
    setSelection(nativeSelection.current);
    setMentionQuery(null);
    inputRef.current?.focus();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    draftRef.current = "";
    setDraft("");
    nativeSelection.current = { start: 0, end: 0 };
    completedSelection.current = null;
    setSelection(nativeSelection.current);
    updateBindings([]);
    selectionHistory.current = [];
    pendingNativeEdit.current = null;
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    draftRef.current = "";
    setDraft("");
    nativeSelection.current = { start: 0, end: 0 };
    completedSelection.current = null;
    setSelection(nativeSelection.current);
    updateBindings([]);
    selectionHistory.current = [];
    pendingNativeEdit.current = null;
    setSlashQuery(null);
    onSlashAction(action);
  }

  const composerPillStyle = {
    width: 36,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  } as const;

  const canSend = Boolean(draft.trim()) || selectedSkill !== null || attachmentIds.length > 0;

  return (
    <>
      {mentionOptions.length ? (
        <ScrollView
          testID="mention-picker"
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
          {mentionOptions.map((mention) => (
            <Pressable
              key={mentionChipKey(mention)}
              accessibilityLabel={t("@{name}", { name: mention.name })}
              onPress={() => insertMention(mention)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <MentionOptionIcon mention={mention} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>@{mention.name}</Text>
                {mention.subtitle ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: tokens.mutedForeground,
                      fontSize: 12.5,
                      marginTop: 2,
                    }}
                  >
                    {mention.subtitle}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {slashSkillOptions.length || slashActionOptions.length ? (
        <ScrollView
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
          {slashSkillOptions.map((skill) => (
            <Pressable
              key={skill.id}
              accessibilityLabel={t("Skill {name}", { name: skill.name })}
              onPress={() => insertSkill(skill)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
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
          {slashActionOptions.map((action) => (
            <Pressable
              key={action.id}
              accessibilityLabel={t(action.label)}
              onPress={() => runSlashAction(action.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <NativeSymbol
                ios="gearshape"
                android="settings-outline"
                size={16}
                color={tokens.mutedForeground}
              />
              <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t(action.label)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 8 }}>
        <MenuView
          actions={attachActions}
          colorScheme={colorScheme}
          onPressAction={(event) => attachFrom(event.nativeEvent.event)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("Attach file")}
            style={{ width: 44, height: 44 }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={styles.composerFill}
            >
              <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
            </GlassSurface>
          </View>
        </MenuView>
        <GlassSurface
          shape="roundedRectangle"
          style={{
            flex: 1,
            minHeight: 44,
            borderRadius: 22,
            flexDirection: "row",
            alignItems: "flex-end",
            // Keeps text clear of the call/send pill even when it runs to the trailing edge (RTL).
            gap: 8,
            paddingStart: 16,
            paddingEnd: 8,
          }}
          fallbackStyle={styles.composerFill}
        >
          <View
            style={{
              flex: 1,
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
                  accessibilityLabel={t("Remove skill {name}", { name: selectedSkill.name })}
                  hitSlop={8}
                  onPress={() => setSelectedSkill(null)}
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
                      updateMentionQuery(
                        resolved.text,
                        nativeSelection.current.start,
                        nativeSelection.current.end,
                      );
                      return;
                    }
                  }
                  selectionHistory.current = [...selectionHistory.current.slice(-3), next];
                  nativeSelection.current = next;
                  setSelection(undefined);
                  if (
                    next.start === completedSelection.current &&
                    next.end === completedSelection.current
                  ) {
                    return;
                  }
                  completedSelection.current = null;
                  updateMentionQuery(draftRef.current, next.start, next.end);
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
                    style={segment.binding ? mentionStyle(segment.binding.mention) : undefined}
                  >
                    {segment.text}
                  </Text>
                ))}
              </TextInput>
            </Pressable>
          </View>
          {!canSend && botId && !onCall ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Call")}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              onPress={() => void startVoiceCall()}
              style={{ marginBottom: 8 }}
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Send")}
              disabled={sending || !canSend}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              onPress={() => void send()}
              style={{ marginBottom: 8, opacity: sending || !canSend ? 0.5 : 1 }}
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
          )}
        </GlassSurface>
        {working ? (
          <Pressable
            accessibilityLabel={t("Stop")}
            disabled={sending}
            onPress={() => void stop()}
            style={{ width: 44, height: 44, opacity: sending ? 0.5 : 1 }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={{ borderColor: tokens.glassStroke, borderWidth: 1 }}
            >
              <NativeSymbol ios="stop.fill" android="stop" size={15} color={tokens.foreground} />
            </GlassSurface>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={16} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>G</Text>
      </View>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}
