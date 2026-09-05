import { type ColorTokens, darkTokens, type ResolvedAppearance } from "@rakazo/ui-tokens";
import Markdown, {
  MarkdownStream,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { sanitizeMarkdownUrl } from "./markdown";

function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      fontSize: 15.5,
      lineHeight: 23,
      width: "100%",
      minWidth: 0,
      flexShrink: 1,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 9,
      width: "100%",
      flexShrink: 1,
    },
    heading1: {
      color: palette.foreground,
      fontSize: 21,
      lineHeight: 27,
      marginTop: 10,
      marginBottom: 5,
    },
    heading2: {
      color: palette.foreground,
      fontSize: 19,
      lineHeight: 25,
      marginTop: 10,
      marginBottom: 5,
    },
    heading3: {
      color: palette.foreground,
      fontSize: 17,
      lineHeight: 23,
      marginTop: 8,
      marginBottom: 4,
    },
    strong: {
      color: palette.foreground,
      fontWeight: "700",
    },
    link: {
      color: palette.link,
      textDecorationLine: "underline",
      marginBottom: 0,
    },
    code_inline: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 0,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence: {
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence_code: {
      backgroundColor: palette.background,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: palette.border,
    },
    table: {
      borderColor: palette.border,
    },
    tr: {
      borderColor: palette.border,
    },
    hr: {
      backgroundColor: palette.border,
    },
    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
  });
}

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules: RenderRules = {
  link: (node, children, _parent, styleMap) => (
    <Text
      accessibilityRole="link"
      key={node.key}
      style={styleMap.link}
      onPress={() => {
        void openSafeLink(node.attributes.href ?? "");
      }}
    >
      {children}
    </Text>
  ),
};

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const sharedProps = {
    colorScheme,
    style: styles,
    rules: renderRules,
    allowedImageHandlers: ["https://", "http://"],
    onLinkPress: (url: string) => {
      void openSafeLink(url);
      return false;
    },
  };

  return (
    <View style={layout.wrap}>
      {streaming ? (
        <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
          {children}
        </MarkdownStream>
      ) : (
        <Markdown {...sharedProps}>{children}</Markdown>
      )}
    </View>
  );
});

const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
});

export type { ChatMarkdownProps } from "./markdown";
