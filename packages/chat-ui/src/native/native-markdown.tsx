import { linkLabel } from "@rakazo/contracts";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { fontWeight, MAX_FONT_SCALE, typeScale } from "@rakazo/ui-tokens";
import type { ReactElement } from "react";
import { useCallback, useContext, useMemo, useState } from "react";
import { Platform } from "react-native";
import type {
  LinkPillContent,
  MarkdownCodeBlock,
  MarkdownImageBlock,
  MarkdownImageOccurrence,
  MarkdownLinkOccurrence,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import {
  inlineMarkdownImageSrc,
  isProseFence,
  linkFaviconOrigin,
  markdownMentionId,
  markdownPageId,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  useLinkFavicons,
} from "../markdown";
import { isMermaidFence } from "../mermaid";
import { CodeFence, MermaidDiagramContext, MermaidFence, ProseFence } from "./code";
import { RemoteMarkdownImage } from "./images";
import type { FenceStyles } from "./styles";

const MONO_FONT = Platform.select({ ios: "Menlo", default: "monospace" });
const BLOCK_GAP = 8;
const WEBSITE_LINK = "^[Hh][Tt][Tt][Pp][Ss]?://";
const MENTION_LINK = "^rakazo-mention:";
const PAGE_LINK = "^page:";
// Addresses the app will not open (any scheme but these) read as plain text, as they do on web.
const UNOPENABLE_LINK =
  "^(?![Hh][Tt][Tt][Pp][Ss]?:|[Mm][Aa][Ii][Ll][Tt][Oo]:|[Tt][Ee][Ll]:|rakazo-mention:|page:)";

/** How a mention link draws and opens: its bot's color, or nothing for a bot that is gone. */
export type MentionLink = { color: string; open: () => void };

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nativeMarkdownStyle(
  palette: ColorTokens,
  mentionColors: ReadonlyMap<string, string>,
  pagesOpen: boolean,
): MarkdownStyle {
  const block = { marginTop: 0, marginBottom: BLOCK_GAP };
  const text = { ...block, color: palette.foreground, fontSize: typeScale.body.fontSize };
  const minorHeading = {
    ...block,
    color: palette.foreground,
    fontSize: typeScale.secondary.fontSize,
    fontWeight: String(fontWeight.semibold),
  };
  // The first pattern that matches an address decides its style, so each bot's own color comes
  // before the plain mention style.
  const linkVariants: MarkdownStyle["linkVariants"] = {};
  for (const [href, color] of mentionColors) {
    linkVariants[`^${escapeRegExp(href)}$`] = { color, underline: false };
  }
  Object.assign(linkVariants, {
    [UNOPENABLE_LINK]: { color: palette.foreground, underline: false },
    [WEBSITE_LINK]: {
      color: palette.foreground,
      underline: true,
      pill: {
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderWidth: 0,
        borderRadius: 4,
      },
    },
    [MENTION_LINK]: { color: palette.foreground, underline: false },
    [PAGE_LINK]: { color: palette.foreground, underline: pagesOpen },
  });
  return {
    paragraph: { ...text, lineHeight: typeScale.body.lineHeight },
    h1: {
      ...block,
      color: palette.foreground,
      fontSize: typeScale.title.fontSize,
      fontWeight: "700",
    },
    h2: {
      ...block,
      color: palette.foreground,
      fontSize: typeScale.headline.fontSize,
      fontWeight: String(fontWeight.semibold),
    },
    h3: { ...text, fontWeight: String(fontWeight.semibold) },
    h4: minorHeading,
    h5: minorHeading,
    h6: minorHeading,
    strong: { color: palette.foreground },
    strikethrough: { color: palette.foreground },
    link: { color: palette.link, underline: true },
    linkVariants,
    // Inline code is set in the monospaced font alone, without a chip around it.
    code: {
      color: palette.foreground,
      fontFamily: MONO_FONT,
      backgroundColor: "transparent",
      borderColor: "transparent",
    },
    codeBlock: {
      ...block,
      color: palette.foreground,
      backgroundColor: palette.secondary,
      borderRadius: 10,
      borderWidth: 0,
      padding: 10,
      fontFamily: MONO_FONT,
      fontSize: typeScale.caption.fontSize,
    },
    blockquote: {
      ...text,
      color: palette.mutedForeground,
      borderColor: palette.faintForeground,
      borderWidth: 3,
      backgroundColor: "transparent",
    },
    list: { ...text, bulletColor: palette.faintForeground, markerColor: palette.faintForeground },
    table: {
      ...block,
      fontSize: typeScale.caption.fontSize,
      color: palette.mutedForeground,
      headerTextColor: palette.foreground,
      headerBackgroundColor: "transparent",
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      borderColor: palette.input,
      borderWidth: 0.5,
    },
    taskList: { checkedColor: palette.foreground, borderColor: palette.faintForeground },
    thematicBreak: { color: palette.border },
  };
}

/** Bot Markdown drawn as native text, with the app's own views for code, diagrams and images. */
export function NativeMarkdown({
  markdown,
  streaming,
  palette,
  colorScheme,
  fenceStyles,
  mentionLink,
  onOpenPage,
  onOpenLink,
}: {
  markdown: string;
  streaming: boolean;
  palette: ColorTokens;
  colorScheme: ResolvedAppearance;
  fenceStyles: FenceStyles;
  mentionLink?: (id: string) => MentionLink | undefined;
  onOpenPage?: (pageId: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const [links, setLinks] = useState<readonly MarkdownLinkOccurrence[]>([]);
  const websiteLinks = useMemo(
    () => links.filter((link) => linkFaviconOrigin(link.url) !== undefined),
    [links],
  );
  const websiteHrefs = useMemo(() => websiteLinks.map((link) => link.url), [websiteLinks]);
  const favicons = useLinkFavicons(websiteHrefs);
  // The bubble hands a new lookup each render; the colors it gives decide the style.
  const mentionColorList = JSON.stringify(
    links.flatMap((link) => {
      const id = markdownMentionId(link.url);
      const color = id ? mentionLink?.(id)?.color : undefined;
      return color ? [[link.url, color]] : [];
    }),
  );
  const mentionColors = useMemo(
    () => new Map<string, string>(JSON.parse(mentionColorList)),
    [mentionColorList],
  );
  const style = useMemo(
    () => nativeMarkdownStyle(palette, mentionColors, Boolean(onOpenPage)),
    [palette, mentionColors, onOpenPage],
  );
  const pillContent = useMemo(() => {
    const content: Record<string, LinkPillContent> = {};
    // Content is keyed by address, so a short label is used only when no link to that address
    // has words of its own.
    const authored = new Set(
      websiteLinks
        .filter((link) => linkLabel(link.label, link.url) === link.label)
        .map((link) => link.url),
    );
    for (const link of websiteLinks) {
      const icon = favicons.get(link.url);
      content[link.url] = {
        ...(authored.has(link.url) ? {} : { label: linkLabel(link.label, link.url) }),
        ...(icon ? { iconUri: icon } : {}),
      };
    }
    return content;
  }, [websiteLinks, favicons]);

  const loadRemote = useContext(RemoteImagesContext);
  const Diagram = useContext(MermaidDiagramContext);
  const renderers = useMemo(
    () => ({
      // Code stays native; only a diagram the app can draw and a plain-text fence, which wraps in
      // the body font, are drawn by the app.
      code: ({ code, language }: MarkdownCodeBlock): ReactElement | undefined => {
        if (isProseFence(language)) {
          return <ProseFence code={code} language={language} styles={fenceStyles} />;
        }
        if (!Diagram || streaming || !isMermaidFence(language) || !code.trim()) return undefined;
        return (
          <MermaidFence
            source={code}
            fallback={
              <CodeFence
                code={code}
                language={language}
                colorScheme={colorScheme}
                styles={fenceStyles}
              />
            }
          />
        );
      },
      image: ({ url, altText, title }: MarkdownImageBlock): ReactElement | undefined => {
        if (inlineMarkdownImageSrc(url)) return undefined;
        const remote = remoteMarkdownImage(url);
        if (!remote) return undefined;
        return (
          <RemoteMarkdownImage
            image={remote}
            alt={altText || undefined}
            title={title || undefined}
            styles={fenceStyles}
          />
        );
      },
    }),
    [Diagram, streaming, colorScheme, fenceStyles],
  );
  // Images inside text, lists, tables and links load only when the reader allowed remote
  // images; until then they keep their placeholder and the address is never requested.
  const resolveImageSource = useCallback(
    (image: MarkdownImageOccurrence) => {
      if (inlineMarkdownImageSrc(image.url)) return undefined;
      const remote = remoteMarkdownImage(image.url);
      if (remote && remoteImageRenders(remote.href, loadRemote, false)) return { uri: remote.href };
      return Promise.reject(new Error("Remote image not allowed"));
    },
    [loadRemote],
  );

  const onLinkPress = useCallback(
    ({ url }: { url: string }) => {
      const mentionId = markdownMentionId(url);
      if (mentionId) {
        mentionLink?.(mentionId)?.open();
        return;
      }
      const pageId = markdownPageId(url);
      if (pageId) {
        onOpenPage?.(pageId);
        return;
      }
      if (sanitizeMarkdownUrl(url)) onOpenLink(url);
    },
    [mentionLink, onOpenPage, onOpenLink],
  );

  return (
    <EnrichedMarkdownText
      // A new resolver only applies to a fresh view, so allowing remote images remounts it.
      key={loadRemote ? "remote" : "local"}
      flavor="github"
      markdown={markdown}
      markdownStyle={style}
      linkPillContent={pillContent}
      onLinksChange={setLinks}
      onLinkPress={onLinkPress}
      renderers={renderers}
      resolveImageSource={resolveImageSource}
      streamingAnimation={streaming}
      dir="auto"
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      selectable={false}
      enableLinkPreview={false}
      enableCodeBlockWrapToggle={false}
    />
  );
}
