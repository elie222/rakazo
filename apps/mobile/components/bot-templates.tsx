import type { BotTemplate } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotTemplateBrowser } from "./bot-template-browser";
import { NativeActionButton } from "./native-action-button";

export function BotTemplates({ onSelect }: { onSelect: (template: BotTemplate) => void }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [open, setOpen] = useState(false);
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
  if (!templates.length) return null;

  function select(template: BotTemplate) {
    onSelect(template);
    setOpen(false);
  }

  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
        {t("Start from a template")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 12 }}
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
        onPress={() => setOpen(true)}
      />
      <BotTemplateBrowser
        templates={templates}
        open={open}
        onClose={() => setOpen(false)}
        onSelect={select}
      />
    </View>
  );
}
