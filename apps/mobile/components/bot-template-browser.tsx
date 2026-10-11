import type { BotTemplate } from "@rakazo/contracts";
import { searchBotTemplates } from "@rakazo/contracts";
import { useState } from "react";
import { Modal, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export type BotTemplateBrowserProps = {
  templates: BotTemplate[];
  open: boolean;
  onClose: () => void;
  onSelect: (template: BotTemplate) => void;
};

export function BotTemplateBrowser({
  templates,
  open,
  onClose,
  onSelect,
}: BotTemplateBrowserProps) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const matches = searchBotTemplates(templates, query);
  return (
    <Modal
      visible={open}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => setQuery("")}
    >
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingHorizontal: 20,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text accessibilityRole="header" style={{ color: tokens.foreground }}>
            {t("Start from a template")}
          </Text>
          <NativeActionButton label={t("Done")} prominence="plain" onPress={onClose} />
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("Search")}
          accessibilityLabel={t("Search")}
          placeholderTextColor={native.secondaryLabel}
          autoCorrect={false}
          style={{
            marginVertical: 20,
            borderRadius: 11,
            padding: 12,
            backgroundColor: native.fill,
            color: native.label,
          }}
        />
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          {matches.map((template) => (
            <NativeActionButton
              key={template.slug}
              label={template.name}
              prominence="plain"
              onPress={() => onSelect(template)}
            />
          ))}
          {!matches.length ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("No matching bots")}</Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
