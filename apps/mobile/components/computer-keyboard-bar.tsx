import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ComputerKeyboardCommand, ComputerKeyName } from "../lib/computer-keyboard";
import {
  COMPUTER_KEYBOARD_SEED,
  commandsForKeyboardChange,
  nextComputerKeyboardDraft,
  normalizeComputerKeyboardEdit,
} from "../lib/computer-keyboard";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

function keySpecs(t: (message: string) => string): Array<{
  name: ComputerKeyName;
  label: string;
  accessibilityLabel: string;
}> {
  return [
    { name: "Escape", label: "Esc", accessibilityLabel: t("Escape") },
    { name: "Tab", label: "Tab", accessibilityLabel: t("Tab") },
    { name: "ArrowLeft", label: "←", accessibilityLabel: t("Left") },
    { name: "ArrowDown", label: "↓", accessibilityLabel: t("Down") },
    { name: "ArrowUp", label: "↑", accessibilityLabel: t("Up") },
    { name: "ArrowRight", label: "→", accessibilityLabel: t("Right") },
  ];
}

export function ComputerKeyboardBar({
  onCommand,
}: {
  onCommand: (command: ComputerKeyboardCommand) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const inputRef = useRef<TextInput>(null);
  const returnAt = useRef(0);
  const [draft, setDraft] = useState(COMPUTER_KEYBOARD_SEED);
  const [open, setOpen] = useState(false);
  const [control, setControl] = useState(false);

  function placeCaretAtEnd() {
    const end = draft.length;
    inputRef.current?.setNativeProps({ selection: { start: end, end } });
  }

  function onChangeText(next: string) {
    const edit = normalizeComputerKeyboardEdit(draft, next);
    if (!edit.aligned) {
      const end = draft.length;
      inputRef.current?.setNativeProps({ text: draft, selection: { start: end, end } });
      return;
    }
    const latched = control;
    const commands = commandsForKeyboardChange(edit.changes, latched);
    if (commands.some((command) => command.type === "key" && command.name === "Return")) {
      returnAt.current = Date.now();
    }
    for (const command of commands) onCommand(command);
    if (latched && commands.length > 0) setControl(false);
    setDraft(edit.draft);
    if (next.length < 1) inputRef.current?.focus();
  }

  function onSubmitEditing() {
    const now = Date.now();
    if (now - returnAt.current < 30) return;
    returnAt.current = now;
    onCommand(
      control ? { type: "key", name: "Return", control: true } : { type: "key", name: "Return" },
    );
    if (control) setControl(false);
    setDraft((current) => nextComputerKeyboardDraft(`${current}\n`));
  }

  function press(name: ComputerKeyName) {
    onCommand(control ? { type: "key", name, control: true } : { type: "key", name });
    if (control) setControl(false);
  }

  const keys = keySpecs(t);

  return (
    <View
      style={[
        styles.bar,
        {
          borderTopColor: tokens.border,
          backgroundColor: tokens.background,
          paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8),
        },
      ]}
    >
      <TextInput
        ref={inputRef}
        value={draft}
        onChangeText={onChangeText}
        onSelectionChange={(event) => {
          const { start, end } = event.nativeEvent.selection;
          if (start >= draft.length && end >= draft.length) return;
          placeCaretAtEnd();
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={false}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardAppearance={appearance}
        accessibilityLabel={t("Computer keyboard")}
        style={styles.input}
      />
      <NativeActionButton
        accessibilityLabel={open ? t("Hide keyboard") : t("Show keyboard")}
        icon={{ ios: "keyboard", android: "keypad-outline" }}
        size="compact"
        prominence="secondary"
        fill
        selected={open}
        onPress={() => (open ? inputRef.current?.blur() : inputRef.current?.focus())}
        style={styles.toggle}
      />
      {keys.slice(0, 2).map((key) => (
        <NativeActionButton
          key={key.name}
          label={key.label}
          accessibilityLabel={key.accessibilityLabel}
          size="compact"
          prominence="secondary"
          fill
          onPress={() => press(key.name)}
          style={styles.key}
        />
      ))}
      <NativeActionButton
        label="Ctrl"
        accessibilityLabel={t("Control")}
        size="compact"
        prominence="secondary"
        fill
        selected={control}
        onPress={() => setControl((value) => !value)}
        style={styles.key}
      />
      {keys.slice(2).map((key) => (
        <NativeActionButton
          key={key.name}
          label={key.label}
          accessibilityLabel={key.accessibilityLabel}
          size="compact"
          prominence="secondary"
          fill
          onPress={() => press(key.name)}
          style={styles.key}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderTopWidth: 1,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  input: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0.02,
    bottom: 0,
    left: 0,
  },
  toggle: { width: 40 },
  key: { flex: 1, minWidth: 0 },
});
