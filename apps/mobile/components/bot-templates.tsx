import type { BotTemplate } from "@rakazo/contracts";
import { searchBotTemplates } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function BotTemplates({ onSelect }: { onSelect: (template: BotTemplate) => void }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    void rpc<BotTemplate[]>("bots/templates")
      .then((items) => {
        if (active) setTemplates(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const matches = searchBotTemplates(templates, query);
  if (!templates.length) return null;

  function select(template: BotTemplate) {
    onSelect(template);
    setOpen(false);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.label}>{t("Start from a template")}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.picks}
      >
        {templates
          .filter((template) => template.featured)
          .slice(0, 8)
          .map((template) => (
            <NativeActionButton
              key={template.slug}
              label={template.name}
              prominence="secondary"
              size="compact"
              onPress={() => select(template)}
            />
          ))}
      </ScrollView>
      <NativeActionButton
        label={t("Browse all")}
        prominence="plain"
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.label}>
              {t("Start from a template")}
            </Text>
            <NativeActionButton
              label={t("Done")}
              prominence="plain"
              onPress={() => setOpen(false)}
            />
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("Search")}
            accessibilityLabel={t("Search")}
            placeholderTextColor={native.secondaryLabel}
            style={styles.search}
            autoCorrect={false}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.list}
          >
            {matches.map((template) => (
              <NativeActionButton
                key={template.slug}
                label={template.name}
                prominence="plain"
                onPress={() => select(template)}
              />
            ))}
            {!matches.length ? <Text style={styles.label}>{t("No matching bots")}</Text> : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { marginBottom: 16 },
    label: { color: tokens.mutedForeground, fontSize: 14 },
    picks: { gap: 8, paddingVertical: 12 },
    sheet: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
    },
    search: {
      margin: 20,
      borderRadius: 11,
      padding: 12,
      backgroundColor: native.fill,
      color: native.label,
    },
    list: { paddingHorizontal: 20, paddingBottom: 24 },
  });
}
