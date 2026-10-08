import {
  Button,
  ContextMenu,
  Host,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  SwipeActions,
  Text,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  foregroundStyle,
  frame,
  listSectionMargins,
  listStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileBot } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { ArchivedBotListProps } from "./archived-bot-list";

export function ArchivedBotList({
  bots,
  pending,
  onOpen,
  onRestore,
  onDelete,
}: ArchivedBotListProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  function actions(bot: MobileBot) {
    return (
      <>
        <Button
          label={t("Restore")}
          systemImage="arrow.uturn.backward"
          onPress={() => onRestore(bot)}
        />
        {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI Button role, not an ARIA role. */}
        <Button
          label={t("Delete")}
          systemImage="trash"
          role="destructive"
          onPress={() => onDelete(bot)}
        />
      </>
    );
  }
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme} seedColor={tokens.foreground}>
      <List modifiers={[listStyle("insetGrouped")]}>
        <Section
          modifiers={
            iosAtLeast(26)
              ? [
                  listSectionMargins({
                    edges: "top",
                    length: 0,
                  }),
                ]
              : undefined
          }
          footer={<Spacer modifiers={[frame({ height: insets.bottom })]} />}
        >
          <List.ForEach>
            {bots.map((bot) => (
              <SwipeActions key={bot.id} modifiers={[disabled(pending)]}>
                <ContextMenu>
                  <ContextMenu.Trigger>
                    <Button onPress={() => onOpen(bot)} modifiers={[buttonStyle("plain")]}>
                      <HStack spacing={12}>
                        <Text modifiers={[foregroundStyle(tokens.foreground)]}>{bot.name}</Text>
                        <Spacer />
                        <Image
                          systemName="chevron.right"
                          modifiers={[foregroundStyle({ type: "hierarchical", style: "tertiary" })]}
                        />
                      </HStack>
                    </Button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Items>{actions(bot)}</ContextMenu.Items>
                </ContextMenu>
                <SwipeActions.Actions allowsFullSwipe={false}>{actions(bot)}</SwipeActions.Actions>
              </SwipeActions>
            ))}
          </List.ForEach>
        </Section>
      </List>
    </Host>
  );
}
