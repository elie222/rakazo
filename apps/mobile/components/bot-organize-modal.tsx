import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileBot, MobileBotSection } from "../lib/api";
import { native } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export type BotOrganizationUpdate = {
  pinned?: boolean;
  sectionId?: string | null;
};

export function BotOrganizeModal({
  bot,
  sections,
  onClose,
  onUpdate,
  onCreateSection,
}: {
  bot: Pick<MobileBot, "name" | "pinned" | "sectionId">;
  sections: MobileBotSection[];
  onClose: () => void;
  onUpdate: (update: BotOrganizationUpdate) => Promise<void>;
  onCreateSection: (name: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(request: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await request();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update chat");
      setSaving(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="Close chat organization"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <Text style={styles.title} numberOfLines={1}>
            {bot.name}
          </Text>
          <Pressable
            disabled={saving}
            onPress={() => void save(() => onUpdate({ pinned: !bot.pinned }))}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <NativeSymbol
              ios={bot.pinned ? "pin.slash" : "pin"}
              android={bot.pinned ? "pin-outline" : "pin"}
              size={18}
            />
            <Text style={styles.actionLabel}>{bot.pinned ? "Unpin" : "Pin"}</Text>
          </Pressable>
          <Text style={styles.sectionLabel}>Move to</Text>
          <ScrollView style={styles.sectionOptions} keyboardShouldPersistTaps="handled">
            {sections.map((section) => (
              <SectionOption
                key={section.id}
                label={section.name}
                selected={bot.sectionId === section.id}
                disabled={saving || bot.sectionId === section.id}
                onPress={() => void save(() => onUpdate({ sectionId: section.id }))}
              />
            ))}
            <SectionOption
              label="Unassigned"
              selected={bot.sectionId === null}
              disabled={saving || bot.sectionId === null}
              onPress={() => void save(() => onUpdate({ sectionId: null }))}
            />
          </ScrollView>
          {creating ? (
            <View style={styles.newSectionRow}>
              <TextInput
                autoFocus
                value={name}
                onChangeText={setName}
                maxLength={60}
                placeholder="Section name"
                placeholderTextColor={native.secondaryLabel}
                style={styles.newSectionInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create section"
                disabled={saving || !name.trim()}
                onPress={() => void save(() => onCreateSection(name.trim()))}
                style={styles.newSectionSubmit}
              >
                <Text style={styles.newSectionSubmitLabel}>Create</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              disabled={saving}
              onPress={() => setCreating(true)}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <NativeSymbol ios="folder.badge.plus" android="folder-outline" size={18} />
              <Text style={styles.actionLabel}>New section</Text>
            </Pressable>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function SectionOption({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.sectionOption, pressed && styles.pressed]}
    >
      <NativeSymbol ios="folder" android="folder-outline" size={18} />
      <Text style={styles.actionLabel} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <NativeSymbol ios="checkmark" android="checkmark" size={17} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  sheet: {
    maxHeight: "82%",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: "#1C1C1E",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 28,
  },
  title: {
    color: native.label,
    fontSize: 18,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingBottom: 10,
  },
  action: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 11,
    paddingHorizontal: 10,
  },
  pressed: {
    backgroundColor: native.fill,
  },
  actionLabel: {
    flex: 1,
    color: native.label,
    fontSize: 16,
  },
  sectionLabel: {
    color: native.secondaryLabel,
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 6,
  },
  sectionOptions: {
    maxHeight: 230,
  },
  sectionOption: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 11,
    paddingHorizontal: 10,
  },
  newSectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  newSectionInput: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    backgroundColor: native.fill,
    color: native.label,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  newSectionSubmit: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: native.label,
    paddingHorizontal: 14,
  },
  newSectionSubmitLabel: {
    color: native.page,
    fontSize: 14,
    fontWeight: "600",
  },
  error: {
    color: "#FF5364",
    fontSize: 13,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  cancel: {
    alignItems: "center",
    paddingTop: 14,
    paddingBottom: 2,
  },
  cancelLabel: {
    color: native.secondaryLabel,
    fontSize: 16,
    fontWeight: "600",
  },
});
