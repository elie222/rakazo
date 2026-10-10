import {
  BottomSheet,
  Button,
  Host,
  List,
  NavigationStack,
  Section,
  Text,
  TextField,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import { buttonStyle, navigationTitle } from "@expo/ui/swift-ui/modifiers";
import { searchBotTemplates } from "@rakazo/contracts";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import type { BotTemplateBrowserProps } from "./bot-template-browser";

export function BotTemplateBrowser({
  templates,
  open,
  onClose,
  onSelect,
}: BotTemplateBrowserProps) {
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  const [query, setQuery] = useState("");
  const matches = searchBotTemplates(templates, query);
  return (
    <Host colorScheme={scheme} matchContents>
      <BottomSheet
        isPresented={open}
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
        onDismiss={() => setQuery("")}
      >
        <NavigationStack>
          <Toolbar>
            <List modifiers={[navigationTitle(t("Start from a template"))]}>
              <Section>
                <TextField placeholder={t("Search")} onTextChange={setQuery} />
              </Section>
              <Section>
                <List.ForEach>
                  {matches.map((template) => (
                    <Button
                      key={template.slug}
                      label={template.name}
                      modifiers={[buttonStyle("plain")]}
                      onPress={() => onSelect(template)}
                    />
                  ))}
                </List.ForEach>
                {!matches.length ? <Text>{t("No matching bots")}</Text> : null}
              </Section>
            </List>
            <Toolbar.Content>
              <ToolbarItem placement="confirmationAction">
                <Button label={t("Done")} onPress={onClose} />
              </ToolbarItem>
            </Toolbar.Content>
          </Toolbar>
        </NavigationStack>
      </BottomSheet>
    </Host>
  );
}
