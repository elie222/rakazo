import type { ChatModelChoice } from "@rakazo/core";
import { useNavigation } from "expo-router";
import { useEffect, useState } from "react";
import { Modal, Platform, Text, useWindowDimensions, View } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { chatModelPickerChoices } from "../../lib/chat-model";
import { useI18n } from "../../lib/i18n";
import { errorText } from "../../lib/user-error";
import { ModelPickerList } from "../model-picker-list";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";

export type ThreadModelPickerRole = "main" | "computer";

export type ThreadModelSave = {
  provider: string | null;
  modelId: string | null;
};

/**
 * The model picker as a bottom sheet from the chat's quick-access cards, so a pick lands
 * without leaving the chat. Android uses the native bottom sheet; iOS uses a form sheet,
 * and Android without the native sheet falls back to a modal, following BotOrganizeModal.
 */
export function ThreadModelPickerSheet({
  visible,
  role,
  botId,
  userId,
  selectedKey,
  onClose,
  onSaved,
}: {
  visible: boolean;
  role: ThreadModelPickerRole;
  botId: string;
  userId: string;
  selectedKey: string;
  onClose: () => void;
  onSaved: (choice: ThreadModelSave) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const navigation = useNavigation();
  const Sheet = useNativeSheet();
  const { height } = useWindowDimensions();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const title = role === "main" ? t("Main model") : t("Computer model");

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setChoices(null);
    setLoadError(null);
    setError(null);
    void Promise.all([rpc("me"), rpc("models/list"), rpc("models/credentials")])
      .then(([me, catalog, credentials]) => {
        if (cancelled) return;
        setChoices(chatModelPickerChoices(me, catalog, credentials, selectedKey, t));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err, t("Could not load model settings")));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, selectedKey, t]);

  // The list puts its search bar on this screen's header on iOS; clear it when the
  // sheet goes away so the chat header does not keep a search bar behind it.
  useEffect(
    () => () => {
      navigation.setOptions({ headerSearchBarOptions: undefined });
    },
    [navigation],
  );

  async function select(choice: ChatModelChoice) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const provider = choice.provider ?? null;
      const modelId = choice.modelId ?? null;
      if (role === "main") {
        await rpc("bots/update", { botId, modelProvider: provider, modelId });
      } else {
        await rpc("models/setRole", {
          role: "computer",
          expectedUserId: userId,
          scope: "account",
          primary: provider && modelId ? { provider, modelId } : null,
        });
      }
      onSaved({ provider, modelId });
      onClose();
    } catch (err) {
      setError(errorText(err, t("Could not save that model")));
    } finally {
      setSaving(false);
    }
  }

  if (!visible || Sheet === undefined) return null;

  const content = (
    <View
      style={{
        ...(Sheet ? { height: Math.floor(height * 0.72) } : { flex: 1 }),
        backgroundColor: tokens.card,
      }}
    >
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
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>{title}</Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={onClose} />
      </View>
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.destructive, paddingHorizontal: 20, paddingBottom: 8 }}
        >
          {error}
        </Text>
      ) : null}
      <View style={{ flex: 1 }}>
        <ModelPickerList
          choices={choices}
          selectedKey={selectedKey}
          error={loadError}
          onSelect={(choice) => void select(choice)}
        />
      </View>
    </View>
  );

  if (Sheet) {
    return (
      <NativeSheet Sheet={Sheet} onClose={onClose} expanded label={title}>
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
