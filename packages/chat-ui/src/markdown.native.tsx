import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { darkTokens } from "@rakazo/ui-tokens";
import { createMarkdownIt } from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { LinkFaviconsPausedContext } from "./markdown";
import { DiagramSurfaceContext } from "./native/code";
import { useNativeLinkConfirm } from "./native/links";
import type { MentionLink } from "./native/native-markdown";
import { NativeMarkdown } from "./native/native-markdown";
import { layout, markdownStyles } from "./native/styles";

const markdownParser = createMarkdownIt();
// Every code block needs a fence, four spaces or a tab; every bot row asks, so most skip the parse.
const MAY_HOLD_CODE = /```|~~~| {4}|\t/;

/** The code of each fenced or indented block in a message, as its copy button copies it. */
export function markdownCodeBlocks(markdown: string): string[] {
  if (!MAY_HOLD_CODE.test(markdown)) return [];
  const tokens: { type: string; content: string }[] = markdownParser.parse(markdown, {});
  return tokens
    .filter((token) => token.type === "fence" || token.type === "code_block")
    .map((token) => token.content.replace(/\n$/, ""))
    .filter((code) => /\S/.test(code));
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  mentionLink,
  onOpenPage,
  palette = darkTokens,
  colorScheme = "dark",
}: Omit<ChatMarkdownProps, "renderMention"> & {
  /** How a mention link draws and opens; without it a mention reads as its plain name. */
  mentionLink?: (id: string) => MentionLink | undefined;
  palette?: ColorTokens;
  colorScheme?: ResolvedAppearance;
}) {
  const openLink = useNativeLinkConfirm();
  const fenceStyles = useMemo(() => markdownStyles(palette), [palette]);
  const diagramSurface = useMemo(
    () => ({ streaming, palette, colorScheme }),
    [streaming, palette, colorScheme],
  );
  return (
    <View style={layout.wrap}>
      <LinkFaviconsPausedContext.Provider value={streaming}>
        <DiagramSurfaceContext.Provider value={diagramSurface}>
          <NativeMarkdown
            markdown={children}
            streaming={streaming}
            palette={palette}
            colorScheme={colorScheme}
            fenceStyles={fenceStyles}
            mentionLink={mentionLink}
            onOpenPage={onOpenPage}
            onOpenLink={openLink}
          />
        </DiagramSurfaceContext.Provider>
      </LinkFaviconsPausedContext.Provider>
    </View>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export {
  LinkFaviconsContext,
  plainTextLinkParts,
  RemoteImagesContext,
  useLinkFavicon,
  withBlockMentions,
} from "./markdown";
export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
export { PageIcon } from "./native/chips";
export type { MermaidDiagramProps } from "./native/code";
export { CodeCopyButtonContext, MermaidDiagramContext } from "./native/code";
export { LinkifiedText } from "./native/linkified-text";
export { useNativeLinkConfirm } from "./native/links";
export type { MentionLink } from "./native/native-markdown";
export { MarkdownLongPressContext } from "./native/sideways-scroll";
