import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

const COPIED_MS = 2000;

/** Copies a chat code block. The icon turns into a check for a moment once the code is copied. */
export function CodeCopyButton({ code }: { code: string }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  // A new object keeps the check for another COPIED_MS.
  const [copied, setCopied] = useState<object | null>(null);
  useTimeout(() => setCopied(null), copied ? COPIED_MS : null, copied);

  const copy = () => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCopied({});
      })
      .catch(() => undefined);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t`Copied` : t`Copy code`}
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
