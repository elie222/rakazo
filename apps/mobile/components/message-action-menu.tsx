import Ionicons from "@react-native-vector-icons/ionicons";
import type { ComponentProps } from "react";
import { useState, useSyncExternalStore } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { messageMenuPlacement } from "../lib/message-menu-placement";
import { useMobileTokens } from "../lib/native";

export type MessageMenuItem = {
  name: string;
  text: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
};

export type MessageMenuSpec = {
  reactions: { emoji: string; onPress: () => void }[];
  /** Groups of actions, drawn as separate rounded blocks. */
  groups: MessageMenuItem[][];
  /** Where the finger was, so the menu opens next to the message. */
  anchor: { x: number; y: number };
};

let current: MessageMenuSpec | null = null;
const listeners = new Set<() => void>();

function setMenu(next: MessageMenuSpec | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Opens the reaction and action menu for a long-pressed message (Android). */
export function presentMessageMenu(spec: MessageMenuSpec) {
  setMenu(spec);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getMenu = () => current;
const MENU_MAX_WIDTH = 340;

/** Mounted once at the root; draws the menu over everything while one is open. */
export function MessageMenuHost() {
  const menu = useSyncExternalStore(subscribe, getMenu, getMenu);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (!menu) return null;
  const close = () => {
    setSize(null);
    setMenu(null);
  };
  const run = (action: () => void) => {
    close();
    action();
  };
  const { left, top, menuWidth, maxHeight } = messageMenuPlacement({
    width,
    height,
    insets,
    anchor: menu.anchor,
    measuredHeight: size?.height ?? 0,
    maxWidth: MENU_MAX_WIDTH,
  });
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={close}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Cancel")}
        style={[StyleSheet.absoluteFill, { backgroundColor: tokens.overlay }]}
        onPress={close}
      />
      <View
        onLayout={(event) => setSize(event.nativeEvent.layout)}
        style={{
          position: "absolute",
          left,
          top,
          width: menuWidth,
          opacity: size ? 1 : 0,
          maxHeight,
        }}
      >
        <ScrollView style={{ maxHeight }} bounces={false} contentContainerStyle={{ gap: 10 }}>
          {menu.reactions.length > 0 ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                justifyContent: "space-between",
                gap: 4,
                padding: 8,
                borderRadius: 28,
                backgroundColor: tokens.card,
              }}
            >
              {menu.reactions.map((reaction) => (
                <Pressable
                  key={reaction.emoji}
                  accessibilityRole="button"
                  accessibilityLabel={reaction.emoji}
                  onPress={() => run(reaction.onPress)}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? tokens.accent : tokens.muted,
                  })}
                >
                  <Text style={{ fontSize: 24 }}>{reaction.emoji}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {menu.groups
            .filter((group) => group.length > 0)
            .map((group, groupIndex) => (
              <View
                key={`${groupIndex}-${group[0]?.name}`}
                style={{ borderRadius: 18, overflow: "hidden", backgroundColor: tokens.card }}
              >
                {group.map((item, index) => (
                  <Pressable
                    key={item.name}
                    accessibilityRole="menuitem"
                    onPress={() => run(item.onPress)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 14,
                      paddingHorizontal: 18,
                      paddingVertical: 14,
                      backgroundColor: pressed ? tokens.muted : undefined,
                      borderTopWidth: index > 0 ? StyleSheet.hairlineWidth : 0,
                      borderTopColor: tokens.border,
                    })}
                  >
                    <Ionicons name={item.icon} size={20} color={tokens.foreground} />
                    <Text style={{ color: tokens.foreground, fontSize: 16 }}>{item.text}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
