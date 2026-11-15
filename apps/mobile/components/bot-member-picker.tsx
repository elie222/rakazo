import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileBot } from "../lib/mobile-types";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function BotMemberPicker({
  bots,
  selected,
  onChange,
  onOpenBot,
  disabled = false,
  initiallyExpanded = false,
}: {
  bots: MobileBot[];
  selected: string[];
  onChange: (botIds: string[]) => void;
  /** Makes each bot's avatar and name open that bot; the switch still edits membership. */
  onOpenBot?: (bot: MobileBot) => void;
  disabled?: boolean;
  initiallyExpanded?: boolean;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState("");
  // Bots ever picked this session stay listed when collapsed so an unchecked
  // member remains re-checkable until the form is saved.
  const [everPicked, setEverPicked] = useState<ReadonlySet<string>>(() => new Set(selected));
  const needle = expanded ? query.trim().toLowerCase() : "";
  const base = expanded
    ? bots
    : bots.filter((bot) => everPicked.has(bot.id) || selected.includes(bot.id));
  const visible = needle ? base.filter((bot) => bot.name.toLowerCase().includes(needle)) : base;

  return (
    <View style={{ marginTop: 20 }}>
      <View style={styles.header}>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary, paddingStart: 20 }}>
          {t`Members (${ph({ count: selected.length })})`}
        </Text>
        <NativeActionButton
          label={expanded ? t`Show selected` : t`Show all`}
          prominence="quiet"
          onPress={() => setExpanded((value) => !value)}
        />
      </View>
      {expanded ? (
        <>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t`Filter bots`}
            placeholderTextColor={tokens.faintForeground}
            accessibilityLabel={t`Filter bots`}
            style={{
              marginTop: 8,
              height: 56,
              borderRadius: 28,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              paddingHorizontal: 20,
              color: tokens.foreground,
              fontSize: 16,
            }}
          />
          <Text
            style={{
              color: tokens.mutedForeground,
              ...typeScale.caption,
              marginTop: 8,
              paddingStart: 20,
            }}
          >
            {t`Pick ${ph({ min: GROUP_MEMBER_MIN })}–${ph({ max: GROUP_MEMBER_MAX })}`}
          </Text>
        </>
      ) : null}
      <View>
        {visible.map((bot) => {
          const checked = selected.includes(bot.id);
          const identity = (
            <>
              <BotAvatar
                color={bot.color}
                avatarSet={bot.avatarSet}
                identity={bot.id}
                size={40}
                status={bot.status}
              />
              <Text style={[styles.name, { color: tokens.foreground }]}>{bot.name}</Text>
            </>
          );
          return (
            <View key={bot.id} style={styles.row}>
              {onOpenBot ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={bot.name}
                  disabled={disabled}
                  onPress={() => onOpenBot(bot)}
                  style={({ pressed }) => [styles.identity, { opacity: pressed ? 0.6 : 1 }]}
                >
                  {identity}
                </Pressable>
              ) : (
                identity
              )}
              <NativeSwitch
                accessibilityLabel={bot.name}
                disabled={disabled || (!checked && selected.length >= GROUP_MEMBER_MAX)}
                onValueChange={(next) => {
                  if (next && selected.length >= GROUP_MEMBER_MAX) return;
                  setEverPicked((current) => new Set(current).add(bot.id));
                  onChange(next ? [...selected, bot.id] : selected.filter((id) => id !== bot.id));
                }}
                value={checked}
              />
            </View>
          );
        })}
        {visible.length === 0 ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 14, paddingVertical: 10 }}>
            {expanded ? t`No matching bots` : t`No members yet`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, paddingVertical: 10 },
  identity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 14 },
  name: {
    flex: 1,
    fontSize: typeScale.cardTitle.fontSize,
    lineHeight: typeScale.cardTitle.lineHeight,
  },
});
