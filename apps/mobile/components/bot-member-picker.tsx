import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSwitch } from "./native-switch";

export function BotMemberPicker({
  bots,
  selected,
  onChange,
  disabled = false,
  initiallyExpanded = false,
}: {
  bots: MobileBot[];
  selected: string[];
  onChange: (botIds: string[]) => void;
  disabled?: boolean;
  initiallyExpanded?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState("");
  // Bots ever picked this session stay listed when collapsed so an unchecked
  // member remains re-checkable until the form is saved.
  const [everPicked, setEverPicked] = useState<ReadonlySet<string>>(() => new Set(selected));
  const needle = expanded ? query.trim().toLowerCase() : "";
  const base = expanded ? bots : bots.filter((bot) => everPicked.has(bot.id));
  const visible = needle
    ? base.filter(
        (bot) =>
          bot.name.toLowerCase().includes(needle) || bot.title.toLowerCase().includes(needle),
      )
    : base;

  return (
    <View style={{ marginTop: 20 }}>
      <View style={styles.header}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
          {t("Members ({count})", { count: selected.length })}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
            {expanded ? t("Show selected") : t("Show all")}
          </Text>
        </Pressable>
      </View>
      {expanded ? (
        <>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("Filter bots")}
            placeholderTextColor={tokens.mutedForeground}
            accessibilityLabel={t("Filter bots")}
            style={{
              marginTop: 8,
              backgroundColor: native.fill,
              borderRadius: 11,
              padding: 10,
              color: tokens.foreground,
              fontSize: 15,
            }}
          />
          <Text style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 8 }}>
            {t("Pick {min}–{max}", { min: GROUP_MEMBER_MIN, max: GROUP_MEMBER_MAX })}
          </Text>
        </>
      ) : null}
      <View>
        {visible.map((bot) => {
          const checked = selected.includes(bot.id);
          return (
            <View key={bot.id} style={styles.row}>
              <BotAvatar color={bot.color} identity={bot.id} size={34} status={bot.status} />
              <Text style={[styles.name, { color: tokens.foreground }]}>{bot.name}</Text>
              <NativeSwitch
                accessibilityLabel={bot.name}
                disabled={disabled || (!checked && selected.length >= GROUP_MEMBER_MAX)}
                onValueChange={(next) => {
                  if (next && selected.length >= GROUP_MEMBER_MAX) return;
                  if (next) setEverPicked((current) => new Set(current).add(bot.id));
                  onChange(next ? [...selected, bot.id] : selected.filter((id) => id !== bot.id));
                }}
                thumbColor={checked ? tokens.primaryForeground : tokens.foreground}
                tintColor={tokens.primary}
                trackColor={{ false: tokens.border, true: tokens.primary }}
                value={checked}
              />
            </View>
          );
        })}
        {visible.length === 0 ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 13, paddingVertical: 10 }}>
            {expanded ? t("No bots match") : t("No members yet")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  name: { flex: 1, fontSize: 16 },
});
