import {
  Button,
  ContextMenu,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  SwipeActions,
  Text,
} from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  foregroundStyle,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { PlatformColor } from "react-native";
import { useI18n } from "../lib/i18n";
import type { MobileBot, MobileGroup } from "../lib/mobile-types";
import { useMobileTokens } from "../lib/native";
import type { ArchivedBotListProps } from "./archived-bot-list";
import { NativeInsetList, useInsetListEdges } from "./native-inset-list";

export function ArchivedBotList({
  bots,
  groups,
  pending,
  onOpen,
  onRestore,
  onDelete,
  onRestoreGroup,
}: ArchivedBotListProps) {
  const { t } = useI18n();
  const edges = useInsetListEdges();
  const tokens = useMobileTokens();
  // A swipe button is filled with its tint and keeps a white label. The host's tint is the
  // ink colour, white in dark mode, and it overrides even a destructive role's red, so each
  // swipe button needs its own fill to stay readable.
  const swipeTint = [tint(PlatformColor("systemBlue"))];
  const swipeDeleteTint = [tint(PlatformColor("systemRed"))];
  function actions(bot: MobileBot, swipe = false) {
    return (
      <>
        <Button
          label={t("Restore")}
          systemImage="arrow.uturn.backward"
          modifiers={swipe ? swipeTint : undefined}
          onPress={() => onRestore(bot)}
        />
        <Button
          label={t("Delete")}
          systemImage="trash"
          // The swipe button is red by its tint, not the destructive role: SwiftUI removes a row
          // as soon as a destructive swipe button is tapped, even when the confirmation is cancelled.
          role={swipe ? undefined : "destructive"}
          modifiers={swipe ? swipeDeleteTint : undefined}
          onPress={() => onDelete(bot)}
        />
      </>
    );
  }
  function groupActions(group: MobileGroup, swipe = false) {
    return (
      <Button
        label={t("Restore")}
        systemImage="arrow.uturn.backward"
        modifiers={swipe ? swipeTint : undefined}
        onPress={() => onRestoreGroup(group)}
      />
    );
  }
  return (
    <NativeInsetList seedColor={tokens.foreground}>
      <Section modifiers={edges.modifiers} header={edges.header} footer={edges.footer}>
        <List.ForEach>
          {bots.map((bot) => (
            <SwipeActions key={bot.id} modifiers={[disabled(pending)]}>
              <ContextMenu modifiers={[contentShape(shapes.rectangle())]}>
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
              <SwipeActions.Actions allowsFullSwipe={false}>
                {actions(bot, true)}
              </SwipeActions.Actions>
            </SwipeActions>
          ))}
          {groups.map((group) => (
            <SwipeActions key={`group-${group.id}`} modifiers={[disabled(pending)]}>
              <ContextMenu modifiers={[contentShape(shapes.rectangle())]}>
                <ContextMenu.Trigger>
                  <HStack
                    spacing={12}
                    modifiers={[
                      accessibilityElement("ignore"),
                      accessibilityLabel(`${group.name}, ${t("Group")}`),
                    ]}
                  >
                    <Image
                      systemName="person.2"
                      modifiers={[foregroundStyle({ type: "hierarchical", style: "secondary" })]}
                    />
                    <Text modifiers={[foregroundStyle(tokens.foreground)]}>{group.name}</Text>
                    <Spacer />
                  </HStack>
                </ContextMenu.Trigger>
                <ContextMenu.Items>{groupActions(group)}</ContextMenu.Items>
              </ContextMenu>
              <SwipeActions.Actions allowsFullSwipe={false}>
                {groupActions(group, true)}
              </SwipeActions.Actions>
            </SwipeActions>
          ))}
        </List.ForEach>
      </Section>
    </NativeInsetList>
  );
}
