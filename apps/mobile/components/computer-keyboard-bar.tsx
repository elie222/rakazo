import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ComputerKeyboardCommand, ComputerKeyName } from "../lib/computer-keyboard";
import { commandsForKeyboardChange, computerKeyboardChanges } from "../lib/computer-keyboard";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

// Some Android keyboards report a Backspace key press just after the change that deleted with it.
const DELETE_KEY_PRESS_MS = 50;

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
  active,
  onCommand,
}: {
  /** False once the screen is closing; the bar can stay mounted while it animates away. */
  active: boolean;
  onCommand: (command: ComputerKeyboardCommand) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const inputRef = useRef<TextInput>(null);
  // The field's text as last handled, updated at once. A keystroke can be reported twice before
  // React re-renders; measured from here, the repeat finds nothing new to send.
  const handled = useRef("");
  const deletedAt = useRef<number | null>(null);
  const backspacePressed = useRef(false);
  // On from the keyboard toggle until an explicit close; while on, a blur gives focus straight back.
  const keepOpen = useRef(false);
  const control = useRef(false);
  const [open, setOpen] = useState(false);
  const [controlLatched, setControlLatched] = useState(false);

  // Backgrounding is left to iOS, which keeps the keyboard and brings it back on return. A blur
  // while in the background is never seen by the keyboard tracking, which leaves a gap.
  useEffect(
    () => () => {
      keepOpen.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    if (active) return;
    keepOpen.current = false;
    inputRef.current?.blur();
  }, [active]);

  function latch(next: boolean) {
    control.current = next;
    setControlLatched(next);
  }

  function send(changes: { backspaces: number; text: string }) {
    if (!active) return;
    const commands = commandsForKeyboardChange(changes, control.current);
    for (const command of commands) onCommand(command);
    if (control.current && commands.length > 0) latch(false);
  }

  function onChangeText(next: string) {
    const changes = computerKeyboardChanges(handled.current, next);
    handled.current = next;
    if (changes.backspaces > 0) {
      deletedAt.current = backspacePressed.current ? null : Date.now();
    }
    backspacePressed.current = false;
    send(changes);
  }

  // An empty field reports no change for Backspace, so its key press is the only signal there.
  // With text, the change carries the deletion, whichever of the two arrives first.
  function onKeyPress(key: string) {
    if (!active || key !== "Backspace") return;
    const deleted = deletedAt.current;
    deletedAt.current = null;
    if (deleted !== null && Date.now() - deleted < DELETE_KEY_PRESS_MS) return;
    if (handled.current) {
      backspacePressed.current = true;
      return;
    }
    send({ backspaces: 1, text: "" });
  }

  // Edits only count at the end, where the remote caret is, so a caret moved by holding Space
  // goes straight back there. A selection reported before its own change asks for the old end;
  // the field drops that request as out of date, and the change still sends.
  function onSelectionChange(start: number, end: number) {
    const length = handled.current.length;
    if (start < length || end < length) inputRef.current?.setSelection(length, length);
  }

  function onBlur() {
    if (keepOpen.current) {
      inputRef.current?.focus();
      return;
    }
    setOpen(false);
  }

  function toggle() {
    if (!active) return;
    if (open) {
      keepOpen.current = false;
      inputRef.current?.blur();
      return;
    }
    keepOpen.current = true;
    inputRef.current?.focus();
  }

  function press(name: ComputerKeyName) {
    if (!active) return;
    onCommand(control.current ? { type: "key", name, control: true } : { type: "key", name });
    if (control.current) latch(false);
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
        onChangeText={onChangeText}
        onKeyPress={(event) => onKeyPress(event.nativeEvent.key)}
        onSelectionChange={(event) =>
          onSelectionChange(event.nativeEvent.selection.start, event.nativeEvent.selection.end)
        }
        onFocus={() => setOpen(true)}
        onBlur={onBlur}
        onSubmitEditing={() => press("Return")}
        submitBehavior="submit"
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
        onPress={toggle}
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
        selected={controlLatched}
        onPress={() => latch(!control.current)}
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
