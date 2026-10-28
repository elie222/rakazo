import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { buildComposerMentionOptions, ComposerMention, SlashActionId } from "@rakazo/core";
import {
  mentionChipKey,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import { useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ComposerSnapshot } from "../lib/thread-feedback";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

export type ThreadComposerHandle = {
  snapshot: () => ComposerSnapshot;
  reset: () => void;
  insert: (text: string) => void;
};

type ThreadComposerProps = {
  ref: Ref<ThreadComposerHandle>;
  onFocus?: () => void;
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
  onFocus,
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
  const { fontScale } = useWindowDimensions();
  // The input text stops growing at MAX_FONT_SCALE, so its height limits stop there too.
  const textScale = Math.min(fontScale, MAX_FONT_SCALE);
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const inputRef = useRef<TextInput>(null);
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  useImperativeHandle(ref, () => ({
    snapshot: () => ({
      promptText: serializeComposerPrompt(draft, selectedSkill, selectedMentions),
      mentions: selectedMentions,
      skill: selectedSkill,
      replyTargetId,
      replyQuote,
      attachmentIds,
    }),
    reset: () => {
      setDraft("");
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      setSelectedMentions([]);
    },
    insert: (text) => setDraft((current) => (current ? `${current}\n${text}` : text)),
  }));
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
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
  function updateDraft(value: string) {
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    if (match) onMentionRequested?.();
    setMentionQuery(match ? (match[1] ?? "") : null);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
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

  const canSend =
    Boolean(draft.trim()) ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    attachmentIds.length > 0;

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
            {selectedMentions.map((mention) => (
              <View
                key={mentionChipKey(mention)}
                testID="mention-chip"
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
                <MentionChipIcon mention={mention} />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {mention.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove mention {name}", { name: mention.name })}
                  hitSlop={8}
                  onPress={() =>
                    setSelectedMentions((current) =>
                      current.filter(
                        (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                      ),
                    )
                  }
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ))}
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
              {!draft && !selectedSkill && !selectedMentions.length ? (
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
                onFocus={onFocus}
                value={draft}
                onChangeText={updateDraft}
                accessibilityLabel={composerPrompt}
                onKeyPress={(event) => {
                  if (
                    event.nativeEvent.key === "Backspace" &&
                    draft.length === 0 &&
                    (selectedSkill !== null || selectedMentions.length > 0)
                  ) {
                    removeLastChip();
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
              />
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

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={13} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}
