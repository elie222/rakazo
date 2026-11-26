import { useLingui } from "@lingui/react/macro";
import type { ComputerElement } from "@rakazo/contracts";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { useMobileTokens } from "../../lib/native/native";
import { GlassIconButton } from "../native/glass-icon-button";
import { NativeActionButton } from "../native/native-action-button";

/**
 * A native page sheet over the live screen: type a control's name, pick it from the accessible
 * tree, and the caller clicks it. Nothing here writes state; the screen owns the save.
 */
export function ComputerFindSheet({
  visible,
  query,
  results,
  pending,
  error,
  clickPending,
  onQueryChange,
  onFind,
  onChoose,
  onClose,
}: {
  visible: boolean;
  query: string;
  results: readonly ComputerElement[];
  pending: boolean;
  error: Error | null;
  clickPending: boolean;
  onQueryChange: (query: string) => void;
  onFind: () => void;
  onChoose: (element: ComputerElement) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.foreground }]}>{t`Find on screen`}</Text>
            <GlassIconButton
              accessibilityLabel={t`Close find`}
              onPress={onClose}
              ios="xmark"
              android="close"
              size={36}
              iconSize={16}
            />
          </View>
          <View style={styles.search}>
            <TextInput
              autoFocus
              value={query}
              onChangeText={onQueryChange}
              placeholder={t`Control name`}
              placeholderTextColor={tokens.mutedForeground}
              returnKeyType="search"
              onSubmitEditing={onFind}
              style={[
                styles.input,
                {
                  color: tokens.foreground,
                  borderColor: tokens.border,
                  backgroundColor: tokens.card,
                },
              ]}
            />
            <NativeActionButton
              label={t`Find`}
              prominence="primary"
              busy={pending}
              onPress={onFind}
            />
          </View>
          {error ? (
            <Text style={[styles.error, { color: tokens.destructive }]}>{error.message}</Text>
          ) : null}
          <ScrollView keyboardShouldPersistTaps="handled">
            {results.map((element) => (
              <Pressable
                key={`${element.role ?? ""}:${element.name ?? ""}:${element.point.x}:${element.point.y}`}
                accessibilityRole="button"
                disabled={clickPending}
                onPress={() => onChoose(element)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: tokens.muted }]}
              >
                <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
                  {element.name || element.role || t`Control`}
                </Text>
                {element.role ? (
                  <Text style={[styles.role, { color: tokens.mutedForeground }]}>
                    {element.role}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 17, fontWeight: "600" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  input: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  error: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 14 },
  row: { paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  name: { fontSize: 16 },
  role: { fontSize: 13 },
});
