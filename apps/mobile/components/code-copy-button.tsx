import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

const COPIED_MS = 2000;

/** Copies a chat code block. The icon turns into a check for a moment once the code is copied. */
export function CodeCopyButton({ code }: { code: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = () => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCopied(true);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => undefined);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t("Copied") : t("Copy code")}
      onPress={copy}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <NativeSymbol
        ios={copied ? "checkmark" : "doc.on.doc"}
        android={copied ? "checkmark" : "copy-outline"}
        size={15}
        color={tokens.mutedForeground}
      />
    </Pressable>
  );
}

// Match the code's horizontal padding while centring on its first line.
const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    alignItems: "flex-end",
    paddingRight: 10,
    justifyContent: "center",
  },
});
