import type { ModalBottomSheetRef } from "@expo/ui/jetpack-compose";
import { Box, Host, LazyColumn, ListItem, ModalBottomSheet, Text } from "@expo/ui/jetpack-compose";
import {
  background,
  clickable,
  clip,
  defaultMinSize,
  fillMaxWidth,
  padding,
  Shapes,
  selectable,
  size,
} from "@expo/ui/jetpack-compose/modifiers";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  dismissMessageActionSheet,
  getMessageActionSheet,
  mountMessageActionSheetHost,
  selectMessageActionSheet,
  subscribeMessageActionSheet,
} from "../lib/message-action-sheet-store";

export default function AndroidMessageActionSheetHost() {
  const sheet = useSyncExternalStore(
    subscribeMessageActionSheet,
    getMessageActionSheet,
    getMessageActionSheet,
  );
  const ref = useRef<ModalBottomSheetRef>(null);
  useEffect(mountMessageActionSheetHost, []);
  if (!sheet) return null;
  const tokens = tokensForAppearance(sheet.colorScheme);
  return (
    <Host
      useViewportSizeMeasurement
      colorScheme={sheet.colorScheme}
      seedColor={tokens.primary}
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <ModalBottomSheet
        ref={ref}
        skipPartiallyExpanded
        containerColor={tokens.card}
        contentColor={tokens.foreground}
        scrimColor={tokens.overlay}
        onDismissRequest={() => dismissMessageActionSheet(sheet)}
      >
        <ModalBottomSheet.DragHandle>
          <Box modifiers={[padding(0, 16, 0, 16)]}>
            <Box
              modifiers={[
                size(32, 4),
                clip(Shapes.RoundedCorner(2)),
                background(tokens.mutedForeground),
              ]}
            />
          </Box>
        </ModalBottomSheet.DragHandle>
        <LazyColumn modifiers={[fillMaxWidth()]} contentPadding={{ bottom: 24 }}>
          {sheet.title ? (
            <Text
              color={tokens.foreground}
              style={{ typography: "titleMedium" }}
              modifiers={[padding(16, 8, 16, 20)]}
            >
              {sheet.title}
            </Text>
          ) : null}
          {sheet.actions.map((action, index) => {
            const onPress = () => {
              void selectMessageActionSheet(sheet, index, async () => {
                await ref.current?.hide();
              });
            };
            return (
              <ListItem
                key={`${index}-${action.text}`}
                colors={{ containerColor: tokens.card, contentColor: tokens.foreground }}
                modifiers={[
                  fillMaxWidth(),
                  defaultMinSize({ minHeight: 56 }),
                  sheet.selected === undefined
                    ? clickable(onPress)
                    : selectable(sheet.selected === index, onPress),
                ]}
              >
                <ListItem.HeadlineContent>
                  <Text color={tokens.foreground} style={{ typography: "bodyLarge" }}>
                    {action.text}
                  </Text>
                </ListItem.HeadlineContent>
                {sheet.selected === index ? (
                  <ListItem.TrailingContent>
                    <Text color={tokens.primary} style={{ typography: "bodyLarge" }}>
                      ✓
                    </Text>
                  </ListItem.TrailingContent>
                ) : null}
              </ListItem>
            );
          })}
        </LazyColumn>
      </ModalBottomSheet>
    </Host>
  );
}
