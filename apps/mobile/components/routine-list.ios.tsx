import {
  Button,
  Host,
  HStack,
  List,
  Rectangle,
  Section,
  Spacer,
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
  listSectionMargins,
  listStyle,
  padding,
  scrollContentBackground,
  shapes,
  tint,
  toggleStyle,
} from "@expo/ui/swift-ui/modifiers";
import { PlatformColor, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { routineRowDetail, routineRowLabel } from "../lib/routine";
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
  const insets = useSafeAreaInsets();
  // As in the archived list: the floating header's height is a spacer inside the scroll content.
  const headerInset = useFloatingHeaderInset();
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  return (
    <Host
      // Rebuilt when the appearance changes, so no row keeps the other theme's colours.
      key={scheme}
      style={{ flex: 1, backgroundColor: native.groupedPage }}
      colorScheme={scheme}
      ignoreSafeArea={headerInset > 0 ? "container" : undefined}
    >
      {/* The app's settings colours, as on the profile, instead of the system grouped ones. */}
      <List modifiers={[listStyle("insetGrouped"), scrollContentBackground("hidden")]}>
        <Section
          modifiers={iosAtLeast(26) ? [listSectionMargins({ edges: "top", length: 0 })] : undefined}
          header={
            headerInset > 0 ? (
              <Spacer
                modifiers={[
                  frame({ height: headerInset }),
                  listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
                ]}
              />
            ) : undefined
          }
          footer={<Spacer modifiers={[frame({ height: insets.bottom })]} />}
        >
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
      </List>
    </Host>
  );
}
