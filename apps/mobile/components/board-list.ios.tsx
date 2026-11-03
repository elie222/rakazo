import { Button, Host, List, Menu, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowInsets,
  listSectionMargins,
  listStyle,
  multilineTextAlignment,
  refreshable,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ticketStatusLabel } from "../lib/board";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { BoardListProps } from "./board-list";

/** A SwiftUI inset list: a section per column, and a pull-down menu on each ticket to move it. */
export function BoardList({ sections, error, onMove, onRefresh }: BoardListProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // As in the archived list: the floating header's height is a spacer inside the scroll content.
  const headerInset = useFloatingHeaderInset();
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  const lastStatus = sections.at(-1)?.status;
  return (
    <Host
      // Rebuilt when the appearance changes, so no row keeps the other theme's colours.
      key={scheme}
      style={{ flex: 1, backgroundColor: native.groupedPage }}
      colorScheme={scheme}
      seedColor={tokens.foreground}
      ignoreSafeArea={headerInset > 0 ? "container" : undefined}
    >
      <List modifiers={[listStyle("insetGrouped"), refreshable(onRefresh)]}>
        {headerInset > 0 || error ? (
          <Section
            modifiers={
              iosAtLeast(26) ? [listSectionMargins({ edges: "top", length: 0 })] : undefined
            }
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
            footer={
              error ? <Text modifiers={[font({ textStyle: "footnote" })]}>{error}</Text> : undefined
            }
          >
            {null}
          </Section>
        ) : null}
        {sections.map((section) => (
          <Section
            key={section.status}
            title={ticketStatusLabel(section.status, t)}
            footer={
              section.status === lastStatus ? (
                <Spacer modifiers={[frame({ height: insets.bottom })]} />
              ) : undefined
            }
          >
            {section.tickets.map((ticket) => (
              <Menu
                key={ticket.id}
                label={
                  <VStack
                    alignment="leading"
                    spacing={2}
                    modifiers={[
                      frame({ maxWidth: Number.POSITIVE_INFINITY, alignment: "leading" }),
                      contentShape(shapes.rectangle()),
                    ]}
                  >
                    <Text
                      modifiers={[
                        font({ textStyle: "footnote" }),
                        foregroundStyle({ type: "hierarchical", style: "secondary" }),
                      ]}
                    >
                      {ticket.ref}
                    </Text>
                    <Text
                      modifiers={[
                        lineLimit(2),
                        multilineTextAlignment("leading"),
                        foregroundStyle(tokens.foreground),
                      ]}
                    >
                      {ticket.title}
                    </Text>
                  </VStack>
                }
              >
                <Section title={t("Move to")}>
                  {TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => (
                    <Button
                      key={status}
                      label={ticketStatusLabel(status, t)}
                      onPress={() => onMove(ticket, status)}
                    />
                  ))}
                </Section>
              </Menu>
            ))}
          </Section>
        ))}
      </List>
    </Host>
  );
}
