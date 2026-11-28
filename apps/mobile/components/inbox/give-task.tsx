import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { newClientId } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import type { Href } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileBot } from "../../lib/api/mobile-types";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { BotAvatar } from "../bots/bot-avatar";
import { NativeSymbol } from "../native/native-symbol";
import { FALLBACK_COLOR } from "./inbox-rows";

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14, gap: 10 },
    caption: { color: native.secondaryLabel, ...typeScale.secondary, paddingHorizontal: 4 },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 52,
      padding: 6,
      borderRadius: 26,
      borderCurve: "continuous",
      backgroundColor: tokens.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 40,
      paddingStart: 6,
      paddingEnd: 10,
      borderRadius: 20,
      backgroundColor: tokens.accent,
    },
    chipName: { color: native.label, ...typeScale.secondary, fontWeight: "600", maxWidth: 110 },
    field: { flex: 1, minWidth: 0, color: native.label, ...typeScale.body, paddingVertical: 8 },
    send: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.primary,
    },
  });
}

/** With nothing waiting on you, the top of Chats hands out the next task. */
export function GiveTask({
  bots,
  openChat,
}: {
  bots: readonly MobileBot[];
  openChat: (href: Href) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useLingui();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const bot = bots.find((candidate) => candidate.id === chosenId) ?? bots[0];
  const task = useSave<{ bot: MobileBot; text: string }>({
    save: ({ bot: target, text: words }, send) =>
      send("threads/send", { botId: target.id, text: words, clientNonce: newClientId() }),
    onSaved: (_sent, { bot: target }) => {
      setText("");
      openChat({ pathname: "/thread", params: { botId: target.id, name: target.name } });
    },
    onFailed: (error) => Alert.alert(t`Could not send`, errorText(error, t`Try again.`)),
  });
  if (!bot) return null;
  const words = text.trim();
  const submit = () => {
    if (words && !task.pending) task.run({ bot, text: words });
  };
  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>{t`Nothing needs you right now.`}</Text>
      <View style={styles.card}>
        <MenuView
          actions={bots.map((candidate) => ({
            id: candidate.id,
            title: candidate.name,
            ...(candidate.id === bot.id ? { state: "on" as const } : {}),
          }))}
          colorScheme={colorScheme}
          onPressAction={({ nativeEvent }) => setChosenId(nativeEvent.event)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t`Task for ${bot.name}. Choose another bot`}
            style={styles.chip}
          >
            <BotAvatar
              color={bot.color || FALLBACK_COLOR}
              avatarSet={bot.avatarSet}
              identity={bot.id}
              size={26}
              motion="static"
            />
            <Text style={styles.chipName} numberOfLines={1}>
              {bot.name}
            </Text>
            <NativeSymbol
              ios="chevron.down"
              android="chevron-down"
              size={11}
              weight="semibold"
              color={native.secondaryLabel}
            />
          </View>
        </MenuView>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t`Give ${bot.name} a task`}
          placeholderTextColor={native.tertiaryLabel}
          accessibilityLabel={t`Give ${bot.name} a task`}
          returnKeyType="send"
          onSubmitEditing={submit}
          editable={!task.pending}
          style={styles.field}
        />
        {words ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t`Send to ${bot.name}`}
            disabled={task.pending}
            onPress={submit}
            style={({ pressed }) => [styles.send, pressed && { transform: [{ scale: 0.95 }] }]}
          >
            {task.pending ? (
              <ActivityIndicator color={tokens.primaryForeground} />
            ) : (
              <NativeSymbol
                ios="arrow.up"
                android="arrow-up"
                size={17}
                weight="bold"
                color={tokens.primaryForeground}
              />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
