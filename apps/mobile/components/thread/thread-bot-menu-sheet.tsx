import { useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { Modal, Platform, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { confirmClearConversation } from "../../lib/bot-lifecycle";
import { useI18n } from "../../lib/i18n";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";
import { NativeSymbol } from "../native-symbol";
import type { ThreadModelPickerRole } from "./thread-model-picker-sheet";

/**
 * The New Bot menu from the chat header avatar: the bot's settings, models,
 * computer and routines, plus clearing the conversation. Rows that open a
 * screen navigate away; the two model rows open the model picker instead.
 */
export function ThreadBotMenuSheet({
  visible,
  botId,
  onClose,
  onPickModel,
}: {
  visible: boolean;
  botId?: string;
  onClose: () => void;
  onPickModel: (role: ThreadModelPickerRole) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const router = useRouter();
  const Sheet = useNativeSheet();

  if (!visible || Sheet === undefined) return null;

  const rows: {
    key: string;
    label: string;
    sublabel?: string;
    ios: string;
    android: ComponentProps<typeof NativeSymbol>["android"];
    danger?: boolean;
    onPress: () => void;
  }[] = [
    {
      key: "settings",
      label: t("Bot settings"),
      sublabel: t("Name, avatar, bio, and reply style"),
      ios: "gearshape",
      android: "settings-outline",
      onPress: () => {
        if (!botId) return;
        onClose();
        router.push({ pathname: "/bot-settings", params: { botId } });
      },
    },
    {
      key: "mainModel",
      label: t("Main model"),
      ios: "cpu",
      android: "hardware-chip-outline",
      onPress: () => {
        onClose();
        onPickModel("main");
      },
    },
    {
      key: "computerModel",
      label: t("Computer model"),
      ios: "desktopcomputer",
      android: "desktop-outline",
      onPress: () => {
        onClose();
        onPickModel("computer");
      },
    },
    {
      key: "voiceModel",
      label: t("Voice model"),
      ios: "waveform",
      android: "mic-outline",
      onPress: () => {
        onClose();
        router.push("/(settings)/voice");
      },
    },
    {
      key: "computer",
      label: t("Computer"),
      ios: "macbook",
      android: "laptop-outline",
      onPress: () => {
        if (!botId) return;
        onClose();
        router.push({ pathname: "/computer", params: { botId } });
      },
    },
    {
      key: "routines",
      label: t("Routines"),
      ios: "clock.arrow.circlepath",
      android: "time-outline",
      onPress: () => {
        onClose();
        router.push({ pathname: "/routines", params: botId ? { botId } : {} });
      },
    },
    {
      key: "clear",
      label: t("Clear conversation"),
      ios: "trash",
      android: "trash-outline",
      danger: true,
      onPress: () => {
        if (!botId) return;
        onClose();
        confirmClearConversation(botId);
      },
    },
  ];

  const content = (
    <View style={{ backgroundColor: tokens.card, paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: Sheet ? 4 : 12,
          paddingBottom: 8,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {t("Bot menu")}
        </Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={onClose} />
      </View>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={row.label}
          onPress={row.onPress}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: 20,
            paddingVertical: 12,
            ...(pressed ? { backgroundColor: tokens.muted } : null),
          })}
        >
          <NativeSymbol
            ios={row.ios}
            android={row.android}
            size={20}
            color={row.danger ? tokens.destructive : tokens.link}
          />
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: row.danger ? tokens.destructive : tokens.foreground,
                fontSize: 16,
              }}
            >
              {row.label}
            </Text>
            {row.sublabel ? (
              <Text style={{ color: tokens.mutedForeground, fontSize: 13, marginTop: 2 }}>
                {row.sublabel}
              </Text>
            ) : null}
          </View>
          <NativeSymbol
            ios="chevron.right"
            android="chevron-forward-outline"
            size={16}
            color={tokens.mutedForeground}
          />
        </Pressable>
      ))}
    </View>
  );

  if (Sheet) {
    return (
      <NativeSheet Sheet={Sheet} onClose={onClose} label={t("Bot menu")}>
        {content}
      </NativeSheet>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
        {content}
      </Modal>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        {content}
      </View>
    </Modal>
  );
}
