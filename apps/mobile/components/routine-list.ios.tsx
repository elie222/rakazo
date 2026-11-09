import {
  Button,
  HStack,
  List,
  Rectangle,
  Section,
  SwipeActions,
  Text,
  Toggle,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  labelsHidden,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  padding,
  scrollContentBackground,
  shapes,
  tint,
  toggleStyle,
} from "@expo/ui/swift-ui/modifiers";
import { PlatformColor, StyleSheet } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { routineRowDetail, routineRowLabel } from "../lib/routine";
import { NativeInsetList, useInsetListEdges } from "./native-inset-list";
import type { RoutineListProps } from "./routine-list";

/** A SwiftUI inset list, for the system switch and swipe to delete. */
export function RoutineList({
  routines,
  timeZone,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
}: RoutineListProps) {
  const { t } = useI18n();
  const edges = useInsetListEdges();
  const tokens = useMobileTokens();
  // Re-rendered with the appearance, so the rows read the new theme's `native` colours.
  useResolvedAppearance();
  return (
    // The app's settings colours, as on the profile, instead of the system grouped ones.
    <NativeInsetList
      background={native.groupedPage}
      modifiers={[scrollContentBackground("hidden")]}
    >
      <Section modifiers={edges.modifiers} header={edges.header} footer={edges.footer}>
        <List.ForEach>
          {routines.map((routine, index) => {
            const detail = routineRowDetail(routine, timeZone);
            const switchLabel = t("Active: {name}", { name: routine.name });
            return (
              <SwipeActions
                key={routine.id}
                modifiers={[
                  listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
                  listRowBackground(native.groupedCell),
                  listRowSeparator("hidden"),
                ]}
              >
                <VStack alignment="leading" spacing={0}>
                  {/* The settings groups' own divider (colour, width and inset), not the system line. */}
                  {index > 0 ? (
                    <Rectangle
                      modifiers={[
                        frame({ height: StyleSheet.hairlineWidth * 2 }),
                        foregroundStyle(native.separator),
                        padding({ leading: 16 }),
                      ]}
                    />
                  ) : null}
                  <HStack
                    spacing={12}
                    modifiers={[
                      padding({ horizontal: 16, vertical: 12 }),
                      frame({ minHeight: 52 }),
                    ]}
                  >
                    <Button
                      onPress={() => onOpen(routine)}
                      modifiers={[
                        buttonStyle("plain"),
                        accessibilityLabel(routineRowLabel(routine)),
                      ]}
                    >
                      <VStack
                        alignment="leading"
                        spacing={2}
                        modifiers={[
                          frame({ maxWidth: Number.POSITIVE_INFINITY, alignment: "leading" }),
                          contentShape(shapes.rectangle()),
                        ]}
                      >
                        <Text modifiers={[lineLimit(1), foregroundStyle(tokens.foreground)]}>
                          {routine.name}
                        </Text>
                        {detail ? (
                          <Text
                            modifiers={[
                              lineLimit(2),
                              font({ textStyle: "footnote" }),
                              foregroundStyle({ type: "hierarchical", style: "secondary" }),
                            ]}
                          >
                            {detail}
                          </Text>
                        ) : null}
                      </VStack>
                    </Button>
                    <Toggle
                      isOn={routine.active}
                      label={switchLabel}
                      onIsOnChange={(active) => onToggle(routine, active)}
                      modifiers={[
                        toggleStyle("switch"),
                        labelsHidden(),
                        accessibilityLabel(switchLabel),
                        // Only the routine's creator can pause or resume it.
                        disabled(routine.editable === false),
                      ]}
                    />
                  </HStack>
                </VStack>
                {/* While a delete is in flight, and for routines only their creator can change, no row offers it. */}
                {canDelete && routine.editable !== false ? (
                  <SwipeActions.Actions allowsFullSwipe={false}>
                    <Button
                      label={t("Delete")}
                      systemImage="trash"
                      modifiers={[
                        labelStyle("iconOnly"),
                        // Red by tint, not the destructive role: SwiftUI removes a row as soon
                        // as a destructive swipe button is tapped, even when the alert is cancelled.
                        tint(PlatformColor("systemRed")),
                        accessibilityLabel(t("Delete {name}", { name: routine.name })),
                      ]}
                      onPress={() => onDelete(routine)}
                    />
                  </SwipeActions.Actions>
                ) : null}
              </SwipeActions>
            );
          })}
        </List.ForEach>
      </Section>
    </NativeInsetList>
  );
}
