import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { useState } from "react";
import { AccessibilityInfo, Pressable, Text, TextInput, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

export function BotChipPicker({
  bots,
  selected,
  onChange,
}: {
  bots: MobileBot[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const remove = (id: string) => onChange(selected.filter((value) => value !== id));
  const available = bots.filter(
    (bot) =>
      !bot.archivedAt &&
      !selected.includes(bot.id) &&
      (!needle || bot.name.toLowerCase().includes(needle)),
  );
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: 12,
          borderRadius: 11,
          backgroundColor: native.fill,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 16 }}>{t("To:")}</Text>
        {selected.map((id) => {
          const bot = bots.find((item) => item.id === id);
          return bot ? (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={t("Remove {name}", { name: bot.name })}
              onPress={() => remove(id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                padding: 5,
                borderRadius: 16,
                backgroundColor: native.fillPressed,
                opacity: pressed ? 0.6 : 1,
                maxWidth: "100%",
              })}
            >
              <BotAvatar color={bot.color} avatarSet={bot.avatarSet} identity={id} size={20} />
              <Text numberOfLines={1} style={{ color: tokens.foreground, flexShrink: 1 }}>
                {bot.name}
              </Text>
              <NativeSymbol ios="xmark" android="close" size={12} color={tokens.mutedForeground} />
            </Pressable>
          ) : null;
        })}
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={selected.length ? t("Add another") : t("Search bots")}
          placeholderTextColor={tokens.mutedForeground}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          textContentType="none"
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === "Backspace" && !query) onChange(selected.slice(0, -1));
          }}
          style={{
            flexGrow: 1,
            minWidth: 100,
            minHeight: 32,
            color: tokens.foreground,
            fontSize: 16,
            padding: 0,
          }}
        />
      </View>
      <View style={{ marginTop: 12 }}>
        {available.map((bot) => (
          <Pressable
            key={bot.id}
            accessibilityRole="button"
            accessibilityLabel={bot.name}
            onPress={() => {
              if (selected.length >= GROUP_MEMBER_MAX) {
                AccessibilityInfo.announceForAccessibility(
                  t("Pick {min}–{max}", { min: GROUP_MEMBER_MIN, max: GROUP_MEMBER_MAX }),
                );
                return;
              }
              onChange([...selected, bot.id]);
              setQuery("");
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 12,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <BotAvatar
              color={bot.color}
              avatarSet={bot.avatarSet}
              identity={bot.id}
              size={36}
              status={bot.status}
            />
            <Text style={{ color: tokens.foreground, fontSize: 16, flex: 1 }}>{bot.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
