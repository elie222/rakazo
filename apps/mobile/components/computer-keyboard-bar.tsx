import { useLingui } from "@lingui/react/macro";
import * as Clipboard from "expo-clipboard";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ComputerKeyboardCommand, ComputerKeyName } from "../lib/computer-keyboard";
import { commandsForKeyboardChange, computerKeyboardChanges } from "../lib/computer-keyboard";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { androidRipple, withAlpha } from "../lib/ripple";
import { NativeSymbol } from "./native-symbol";

// Some Android keyboards report a Backspace key press just after the change that deleted with it.
const DELETE_KEY_PRESS_MS = 50;

type Symbol = Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">;

/**
 * The keys floating over the bot's screen while you control it. Upright, a keyboard circle
 * beside a pill of Esc, Tab, Ctrl, the arrow keys (shown on request, above the bar) and paste;
 * sideways, all of them in one centred pill so the screen keeps its height.
 */
export function ComputerKeyboardBar({
  active,
  landscape,
  onCommand,
}: {
  /** False once the screen is closing; the bar can stay mounted while it animates away. */
  active: boolean;
  landscape: boolean;
  onCommand: (command: ComputerKeyboardCommand) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const inputRef = useRef<TextInputInstance>(null);
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
  const [arrowsShown, setArrowsShown] = useState(false);

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

  /** Types the phone's clipboard on the remote, where its caret is. */
  async function paste() {
    if (!active) return;
    const text = await Clipboard.getStringAsync().catch(() => "");
    if (text && active) onCommand({ type: "text", text });
  }

  const arrows: Array<{ name: ComputerKeyName; symbol: Symbol; label: string }> = [
    { name: "ArrowLeft", symbol: { ios: "arrow.left", android: "arrow-back" }, label: t`Left` },
    { name: "ArrowDown", symbol: { ios: "arrow.down", android: "arrow-down" }, label: t`Down` },
    { name: "ArrowUp", symbol: { ios: "arrow.up", android: "arrow-up" }, label: t`Up` },
    {
      name: "ArrowRight",
      symbol: { ios: "arrow.right", android: "arrow-forward" },
      label: t`Right`,
    },
  ];
  const key = (
    content: ReactNode,
    accessibilityLabel: string,
    onPress: () => void,
    selected?: boolean,
  ) => (
    <Pressable
      key={accessibilityLabel}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      android_ripple={androidRipple(withAlpha(tokens.foreground, 0.14))}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        selected && { backgroundColor: tokens.primary },
        pressed && { opacity: 0.6 },
      ]}
    >
      {typeof content === "string" ? (
        <Text
          allowFontScaling={false}
          style={[
            styles.keyLabel,
            { color: selected ? tokens.primaryForeground : tokens.foreground },
          ]}
        >
          {content}
        </Text>
      ) : (
        content
      )}
    </Pressable>
  );
  const icon = (symbol: Symbol, selected?: boolean) => (
    <NativeSymbol
      {...symbol}
      size={22}
      color={selected ? tokens.primaryForeground : tokens.foreground}
    />
  );
  const divider = (id: string) => (
    <View key={id} style={[styles.divider, { backgroundColor: tokens.border }]} />
  );
  const keyboardLabel = open ? t`Hide keyboard` : t`Show keyboard`;
  const keyboardSymbol: Symbol = { ios: "keyboard", android: { material: "keyboard-outline" } };
  const modifierKeys = [
    key("Esc", t`Escape`, () => press("Escape")),
    key("Tab", t`Tab`, () => press("Tab")),
    key("Ctrl", t`Control`, () => latch(!control.current), controlLatched),
  ];
  const arrowKeys = arrows.map((arrow) =>
    key(icon(arrow.symbol), arrow.label, () => press(arrow.name)),
  );
  const pasteKey = key(
    icon({ ios: "doc.on.clipboard", android: "clipboard-outline" }),
    t`Paste from your phone`,
    () => void paste(),
  );
  const pill = [styles.pill, { backgroundColor: tokens.card, borderColor: tokens.border }];

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.bar,
        landscape && styles.barLandscape,
        { paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 12) },
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
        // Landscape IMEs otherwise take the whole screen with an extract field, hiding
        // the desktop being typed into.
        disableFullscreenUI
        keyboardAppearance={appearance}
        accessibilityLabel={t`Computer keyboard`}
        style={styles.input}
      />
      {landscape ? (
        <View style={pill}>
          {key(icon(keyboardSymbol, open), keyboardLabel, toggle, open)}
          {divider("after-keyboard")}
          {modifierKeys}
          {divider("after-modifiers")}
          {arrowKeys}
          {divider("after-arrows")}
          {pasteKey}
        </View>
      ) : (
        <>
          {arrowsShown ? (
            <View pointerEvents="box-none" style={styles.arrowRow}>
              <View style={pill}>{arrowKeys}</View>
            </View>
          ) : null}
          <View style={styles.portraitRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={keyboardLabel}
              accessibilityState={{ selected: open }}
              android_ripple={androidRipple(withAlpha(tokens.primaryForeground, 0.2))}
              onPress={toggle}
              style={({ pressed }) => [
                styles.keyboard,
                { backgroundColor: tokens.primary },
                pressed && { opacity: 0.8 },
              ]}
            >
              <NativeSymbol {...keyboardSymbol} size={28} color={tokens.primaryForeground} />
            </Pressable>
            <View style={[pill, styles.portraitPill]}>
              {modifierKeys}
              {key(
                icon(
                  { ios: "arrow.up.and.down.and.arrow.left.and.right", android: "move" },
                  arrowsShown,
                ),
                t`Arrow keys`,
                () => setArrowsShown((shown) => !shown),
                arrowsShown,
              )}
              {pasteKey}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  barLandscape: { alignItems: "center" },
  input: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0.02,
    bottom: 0,
    left: 0,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 52,
    paddingHorizontal: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  portraitRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  portraitPill: { flex: 1, minHeight: 56, justifyContent: "space-around" },
  arrowRow: { flexDirection: "row", justifyContent: "flex-end" },
  keyboard: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  key: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  keyLabel: { fontSize: 15, fontWeight: "500" },
  divider: { width: 1, height: 24, marginHorizontal: 2 },
});
