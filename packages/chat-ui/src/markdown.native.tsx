import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { darkTokens } from "@rakazo/ui-tokens";
import type {
  ASTNode,
  MarkdownStyleMap,
  RenderRules,
} from "@ronradtke/react-native-markdown-display";
import Markdown, {
  createMarkdownIt,
  FitImage,
  MarkdownStream,
} from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import {
  Alert,
  I18nManager,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import {
  inlineMarkdownImageSrc,
  LinkFaviconsContext,
  LinkFaviconsPausedContext,
  linkFaviconOrigin,
  linkifyExplicitUrls,
  linkLabel,
  markdownLinkRequiresConfirmation,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "./markdown";

import { useMarkdownLinkAppOrigin, useMarkdownLinkCopy } from "./markdown-link-prompt";

function keepMarkdownLinkToken(_url: string) {
  return true;
}

const BLOCK_GAP = 10;
const BODY_FONT_SIZE = 15.5;
const LINK_TILE_SIZE = 18;
// Keeps the site icon on the line of the label's first word.
const WORD_JOINER = "\u2060";
// First-strong isolate and its pop: a label's own direction characters cannot reorder the text
// around the link.
const ISOLATE = "\u2068";
const POP_ISOLATE = "\u2069";

// One shared parser: the Markdown components memoize on its identity.
const markdownParser = createMarkdownIt();
markdownParser.validateLink = keepMarkdownLinkToken;
linkifyExplicitUrls(markdownParser);

// Hebrew, Arabic and the other right-to-left scripts, with their presentation forms.
const RTL_LETTER =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

// iOS shapes each paragraph by its first letter but aligns it, and orders rows, by the app's
// direction. Returns the text's direction when it differs from the app's.
function contraryDirection(text: string) {
  const rtl = RTL_LETTER.test(/\p{L}/u.exec(text)?.[0] ?? "");
  if (rtl === I18nManager.isRTL) return undefined;
  return rtl ? "rtl" : "ltr";
}

function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      fontSize: BODY_FONT_SIZE,
      lineHeight: 23,
      width: "100%",
      minWidth: 0,
      flexShrink: 1,
      gap: BLOCK_GAP,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 0,
      width: "100%",
      flexShrink: 1,
    },
    heading1: {
      color: palette.foreground,
      fontSize: 21,
      lineHeight: 27,
      marginTop: 0,
      marginBottom: 0,
    },
    heading2: {
      color: palette.foreground,
      fontSize: 19,
      lineHeight: 25,
      marginTop: 0,
      marginBottom: 0,
    },
    heading3: {
      color: palette.foreground,
      fontSize: 17,
      lineHeight: 23,
      marginTop: 0,
      marginBottom: 0,
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
    // Bot bubbles are filled with `muted`, which `border` matches in light mode,
    // so rules drawn inside a message use the muted foreground to stay visible.
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: palette.mutedForeground,
      gap: BLOCK_GAP,
    },
    table: {
      borderColor: palette.mutedForeground,
      borderWidth: StyleSheet.hairlineWidth,
    },
    tr: {
      borderColor: palette.mutedForeground,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    th: {
      fontWeight: "600",
    },
    hr: {
      backgroundColor: palette.mutedForeground,
      height: StyleSheet.hairlineWidth,
    },
    // Custom keys. An image label outside a text node inherits no color, so it carries the body color.
    plain_text: {
      color: palette.foreground,
    },
    // The tap-to-load placeholder for a remote image: a filled, bordered chip that reads as a
    // control on the muted bot bubble in both themes.
    image_placeholder: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      minHeight: 32,
      maxWidth: "100%",
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.background,
    },
    image_placeholder_icon: {
      width: 14,
      height: 11,
      borderWidth: 1.5,
      borderRadius: 2,
      borderColor: palette.mutedForeground,
    },
    image_placeholder_alt: {
      flexShrink: 1,
      color: palette.foreground,
      fontSize: 14,
    },
    image_placeholder_host: {
      flexShrink: 1,
      color: palette.mutedForeground,
      fontSize: 13,
    },
    // A website link reads in the body colour. The icon tile is not underlined; only the label is.
    website_link: {
      color: palette.foreground,
      fontWeight: "500",
      textDecorationLine: "none",
    },
    website_link_label: {
      color: palette.foreground,
      fontWeight: "500",
      textDecorationLine: "underline",
      textDecorationColor: palette.mutedForeground,
    },
    link_favicon_plate: {
      backgroundColor: palette.faviconPlate,
      padding: 2,
    },
    linked_image: {
      width: "100%",
      maxWidth: "100%",
      alignItems: "flex-start",
      gap: 4,
    },
  });
}

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

const OpenLinkContext = createContext<(url: string) => void>(() => undefined);

function useNativeLinkConfirm() {
  const appOrigin = useMarkdownLinkAppOrigin();
  const copy = useMarkdownLinkCopy();
  return useCallback(
    (raw: string) => {
      const url = sanitizeMarkdownUrl(raw);
      if (!url) return;
      if (!markdownLinkRequiresConfirmation(url, appOrigin)) {
        void openSafeLink(url);
        return;
      }
      // Keep the actual host visible even when userinfo or the path is very long.
      Alert.alert(
        copy.title,
        `${new URL(url).host}\n\n${url}`,
        [
          { text: copy.cancel, style: "cancel" },
          {
            text: copy.open,
            onPress: () => {
              void openSafeLink(url);
            },
          },
        ],
        { cancelable: true },
      );
    },
    [appOrigin, copy],
  );
}

function NativeLink({
  block = false,
  href,
  ...props
}: {
  block?: boolean;
  href: string;
  children?: ReactNode;
  style?: StyleProp<TextStyle> | StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const open = useContext(OpenLinkContext);
  const onPress = (event: { defaultPrevented: boolean }) => {
    if (!event.defaultPrevented) open(href);
  };
  return block ? (
    <Pressable
      {...props}
      style={props.style as StyleProp<ViewStyle>}
      accessibilityRole="link"
      onPress={onPress}
    />
  ) : (
    <Text
      {...props}
      style={props.style as StyleProp<TextStyle>}
      accessibilityRole="link"
      onPress={onPress}
    />
  );
}

function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function soleRemoteImage(node: ASTNode):
  | {
      remote: { href: string; host: string };
      alt?: string;
      title?: string;
    }
  | undefined {
  const parts = node.children.filter(
    (child) => child.type !== "text" || child.content.trim() !== "",
  );
  const only = parts.length === 1 && parts[0]?.type === "image" ? parts[0] : undefined;
  if (!only) return undefined;
  const remote = remoteMarkdownImage(only.attributes.src ?? "");
  if (!remote) return undefined;
  return { remote, alt: only.attributes.alt, title: only.attributes.title };
}

/** The label when it is plain text, the only kind that can be a bare URL. */
function astText(node: ASTNode): string | undefined {
  if (!node.children.every((child) => child.type === "text")) return undefined;
  return node.children.map((child) => child.content).join("");
}

function astHasImage(node: ASTNode): boolean {
  return node.children.some((child) => child.type === "image" || astHasImage(child));
}

/** An inline link to a website, drawn with its site icon. Other links keep the plain link style. */
function isWebsiteLink(node: ASTNode): boolean {
  const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
  return node.type === "link" && Boolean(href && linkFaviconOrigin(href)) && !astHasImage(node);
}

function LinkFavicon({ href, plate }: { href: string; plate: StyleProp<ViewStyle> }) {
  const { icon, unusable } = useLinkFavicon(href);
  const globe = useContext(LinkFaviconsContext)?.globe;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={layout.linkMarker}
    >
      <View style={[layout.linkTile, icon ? plate : undefined]}>
        {icon ? (
          <Image
            source={{ uri: icon }}
            style={layout.linkIcon}
            resizeMode="contain"
            onLoad={(event) => {
              // A 1×1 image is a tracking pixel, not an icon.
              const { width, height } = event.nativeEvent.source;
              if (width <= 1 || height <= 1) unusable();
            }}
            onError={unusable}
          />
        ) : (
          globe
        )}
      </View>
    </View>
  );
}

function enclosingLink(parents: readonly ASTNode[]) {
  return parents.find((parent) => parent.type === "link" || parent.type === "blocklink");
}

function textStyleForParents(
  inherited: unknown,
  parents: readonly ASTNode[],
  styleMap: MarkdownStyleMap,
) {
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)) return undefined;
  const style = { ...(inherited as Record<string, unknown>) };
  const linkParent = enclosingLink(parents);
  if (linkParent && isWebsiteLink(linkParent)) {
    // The label style sets medium weight, but bold inside a label stays bold.
    const label = StyleSheet.flatten(styleMap.website_link_label) ?? {};
    return { ...style, ...label, fontWeight: style.fontWeight ?? label.fontWeight };
  }
  if (!linkParent || sanitizeMarkdownUrl(linkParent.attributes.href ?? "")) return style;
  const linkStyle = StyleSheet.flatten(styleMap.link) ?? {};
  const bodyStyle = StyleSheet.flatten(styleMap.body) ?? {};
  if (style.textDecorationLine === linkStyle.textDecorationLine) delete style.textDecorationLine;
  if (style.color === linkStyle.color) style.color = bodyStyle.color;
  return style;
}

const TABLE_FONT_SIZE = 15.5;
const TABLE_LINE_HEIGHT = 23;
const TABLE_CELL_PADDING = 5;
const TABLE_SINGLE_LINE_HEIGHT = TABLE_LINE_HEIGHT + TABLE_CELL_PADDING * 2;
const TABLE_CELL_GUTTER = 16;
const TABLE_MIN_COLUMN_WIDTH = 64;
const TABLE_MAX_COLUMN_WIDTH = 220;
const TABLE_VISIBLE_EDGE = 8;

type TableLayout = {
  widths: readonly number[];
  viewportWidth: number;
  scrollX: number;
};

const TableLayoutContext = createContext<TableLayout>({
  widths: [],
  viewportWidth: 0,
  scrollX: 0,
});

function columnOffset(widths: readonly number[], index: number) {
  let offset = 0;
  for (let cursor = 0; cursor < index; cursor++) offset += widths[cursor] ?? 0;
  return offset;
}

function columnContributesHeight(
  index: number,
  widths: readonly number[],
  viewportWidth: number,
  scrollX: number,
) {
  const start = columnOffset(widths, index);
  const width = widths[index] ?? 0;
  if (width <= 0) return false;
  if (viewportWidth <= 0) return start === 0;
  const overlap = Math.min(start + width, scrollX + viewportWidth) - Math.max(start, scrollX);
  return overlap > TABLE_VISIBLE_EDGE;
}

function heightMask(widths: readonly number[], viewportWidth: number, scrollX: number) {
  return widths
    .map((_, index) => (columnContributesHeight(index, widths, viewportWidth, scrollX) ? "1" : "0"))
    .join("");
}

const offscreenCell: ViewStyle = {
  height: TABLE_SINGLE_LINE_HEIGHT,
  overflow: "hidden",
};

function glyphEm(char: string) {
  if (char === " " || char === "\n" || char === "\t") return 0.33;
  if ("ilj.,'|:;!".includes(char)) return 0.35;
  if ("mwMW@#%&".includes(char)) return 0.95;
  if (char >= "A" && char <= "Z") return 0.72;
  if (char >= "0" && char <= "9") return 0.62;
  return 0.6;
}

function estimateTextWidth(text: string, bold: boolean) {
  const scale = bold ? 1.08 : 1;
  let width = 0;
  for (const char of text) width += glyphEm(char) * TABLE_FONT_SIZE * scale;
  return width * 1.15;
}

function cellPlainText(node: ASTNode): string {
  if (node.type === "text" || node.type === "code_inline") return node.content;
  if (node.type === "softbreak" || node.type === "hardbreak") return " ";
  return node.children.map(cellPlainText).join("");
}

function columnWidthForText(text: string, bold: boolean) {
  const trimmed = text.trim();
  const content = estimateTextWidth(trimmed, bold);
  const longestWord = trimmed.split(/\s+/).reduce((max, word) => {
    return Math.max(max, estimateTextWidth(word, bold));
  }, 0);
  const needed = Math.max(
    content,
    Math.min(longestWord, TABLE_MAX_COLUMN_WIDTH - TABLE_CELL_GUTTER),
  );
  return Math.min(
    TABLE_MAX_COLUMN_WIDTH,
    Math.max(TABLE_MIN_COLUMN_WIDTH, Math.ceil(needed + TABLE_CELL_GUTTER)),
  );
}

function tableRows(table: ASTNode) {
  const rows: ASTNode[] = [];
  for (const section of table.children) {
    if (section.type === "thead" || section.type === "tbody") {
      for (const row of section.children) {
        if (row.type === "tr") rows.push(row);
      }
    } else if (section.type === "tr") {
      rows.push(section);
    }
  }
  return rows;
}

function contentColumnWidths(table: ASTNode) {
  const rows = tableRows(table);
  const count = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
  const widths = Array.from({ length: count }, () => TABLE_MIN_COLUMN_WIDTH);
  for (const row of rows) {
    row.children.forEach((cell, index) => {
      widths[index] = Math.max(
        widths[index] ?? TABLE_MIN_COLUMN_WIDTH,
        columnWidthForText(cellPlainText(cell), cell.type === "th"),
      );
    });
  }
  return widths;
}

function fittedColumnWidths(table: ASTNode, viewportWidth: number) {
  const widths = contentColumnWidths(table);
  if (widths.length === 0 || viewportWidth <= 0) return widths;
  const sum = widths.reduce((total, width) => total + width, 0);
  if (sum >= viewportWidth) return widths;
  const extra = Math.floor((viewportWidth - sum) / widths.length);
  const fitted = widths.map((width) => width + extra);
  const used = fitted.reduce((total, width) => total + width, 0);
  const last = fitted.length - 1;
  fitted[last] = (fitted[last] ?? 0) + (viewportWidth - used);
  return fitted;
}

function columnStyle(width: number) {
  return {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto" as const,
    width,
    minWidth: width,
    maxWidth: width,
  };
}

function TableCell({
  columnIndex,
  baseStyle,
  children,
}: {
  columnIndex: number;
  baseStyle: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const { widths, viewportWidth, scrollX } = useContext(TableLayoutContext);
  const width = widths[columnIndex] ?? TABLE_MIN_COLUMN_WIDTH;
  const contributes = columnContributesHeight(columnIndex, widths, viewportWidth, scrollX);
  return (
    <View style={[baseStyle, columnStyle(width), contributes ? null : offscreenCell]}>
      {children}
    </View>
  );
}

function TableRow({
  baseStyle,
  children,
}: {
  baseStyle: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const { widths } = useContext(TableLayoutContext);
  const rowWidth = widths.reduce((total, width) => total + width, 0);
  return (
    <View style={[baseStyle, { width: rowWidth, minWidth: rowWidth, flexShrink: 0 }]}>
      {children}
    </View>
  );
}

const tableFrame: ViewStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
  flexDirection: "row",
};

function TableScrollView({
  table,
  children,
  style,
}: {
  table: ASTNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const widths = useMemo(() => fittedColumnWidths(table, viewportWidth), [table, viewportWidth]);
  const contentWidth = widths.reduce((total, width) => total + width, 0);
  const tableLayout = useMemo(
    () => ({ widths, viewportWidth, scrollX }),
    [widths, viewportWidth, scrollX],
  );
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.x;
    setScrollX((current) =>
      heightMask(widths, viewportWidth, current) === heightMask(widths, viewportWidth, next)
        ? current
        : next,
    );
  };
  return (
    <View
      style={tableFrame}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setViewportWidth((current) => (current === next ? current : next));
      }}
    >
      <TableLayoutContext.Provider value={tableLayout}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          scrollEventThrottle={16}
          onScroll={onScroll}
          style={[
            style,
            viewportWidth > 0 ? { width: viewportWidth } : { flexGrow: 1, flexShrink: 1 },
          ]}
          contentContainerStyle={{ flexGrow: 0 }}
        >
          <View style={{ width: contentWidth, minWidth: contentWidth, flexShrink: 0 }}>
            {children}
          </View>
        </ScrollView>
      </TableLayoutContext.Provider>
    </View>
  );
}

type RenderRule = NonNullable<RenderRules["link"]>;

// Automatic basis: `flex: 1` is zero-width and collapses a shrink-wrapped list bubble.
function listItemRule(
  node: Parameters<RenderRule>[0],
  children: ReactNode[],
  parent: Parameters<RenderRule>[2],
  styleMap: Parameters<RenderRule>[3],
): ReactNode {
  const body = StyleSheet.flatten(styleMap.body) as TextStyle | undefined;
  // An item written against the app's direction puts its marker on the far side, read its way.
  const direction = contraryDirection(cellPlainText(node));
  const row = [styleMap._VIEW_SAFE_list_item, direction && layout.reversedRow];
  const marker: TextStyle = {
    color: body?.color,
    fontSize: body?.fontSize,
    lineHeight: body?.lineHeight,
    writingDirection: direction,
  };
  // `parent` lists ancestors nearest first; the nearest list decides the marker, so an ordered
  // list nested in a bulleted one is numbered.
  const list = parent.find(
    (ancestor) => ancestor.type === "bullet_list" || ancestor.type === "ordered_list",
  );
  if (list?.type === "bullet_list") {
    return (
      <View key={node.key} style={row}>
        <Text style={[marker, styleMap.bullet_list_icon]} accessible={false}>
          {Platform.select({ android: "\u2022", ios: "\u00B7", default: "\u2022" })}
        </Text>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  if (list?.type === "ordered_list") {
    const start = Number(list.attributes?.start);
    const number = Number.isFinite(start) ? start + node.index : node.index + 1;
    return (
      <View key={node.key} style={row}>
        <Text style={[marker, styleMap.ordered_list_icon]}>
          {number}
          {node.markup}
        </Text>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  return (
    <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
      {children}
    </View>
  );
}

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules: RenderRules = {
  list_item: listItemRule,
  textgroup: (node, children, _parent, styleMap) => (
    <Text
      key={node.key}
      style={[styleMap.textgroup, contraryDirection(cellPlainText(node)) && layout.farSideBlock]}
    >
      {children}
    </Text>
  ),
  text: (node, _children, parents, styleMap, inherited) => (
    <Text key={node.key} style={textStyleForParents(inherited, parents, styleMap)}>
      {node.content}
    </Text>
  ),
  table: (node, children, _parent, styleMap) => (
    <TableScrollView key={node.key} table={node} style={styleMap._VIEW_SAFE_table}>
      {children}
    </TableScrollView>
  ),
  tr: (node, children, _parent, styleMap) => (
    <TableRow key={node.key} baseStyle={styleMap._VIEW_SAFE_tr}>
      {children}
    </TableRow>
  ),
  th: (node, children, _parent, styleMap) => (
    <TableCell key={node.key} columnIndex={node.index} baseStyle={styleMap._VIEW_SAFE_th}>
      {children}
    </TableCell>
  ),
  td: (node, children, _parent, styleMap) => (
    <TableCell key={node.key} columnIndex={node.index} baseStyle={styleMap._VIEW_SAFE_td}>
      {children}
    </TableCell>
  ),
  link: (node, children, _parent, styleMap) => renderMarkdownLink(node, children, styleMap, false),
  blocklink: (node, children, _parent, styleMap) =>
    renderMarkdownLink(node, children, styleMap, true),
  // Replaces the library rule, which loads any http(s) image and prefixes https:// to the rest.
  image: (node, _children, parents, styleMap) => {
    const src = node.attributes.src ?? "";
    const alt = node.attributes.alt;
    if (inlineMarkdownImageSrc(src)) {
      return (
        <FitImage
          key={node.key}
          // Embedded data has nothing to load; the spinner would stay over the image.
          indicator={false}
          style={styleMap._VIEW_SAFE_image}
          source={{ uri: src }}
          accessible={Boolean(alt)}
          accessibilityLabel={alt}
        />
      );
    }
    const linkParent = enclosingLink(parents);
    const linkOpens = Boolean(linkParent && sanitizeMarkdownUrl(linkParent.attributes.href ?? ""));
    const labelStyle = linkOpens ? styleMap.link : styleMap.plain_text;
    const remote = remoteMarkdownImage(src);
    if (remote) {
      return (
        <RemoteMarkdownImage
          key={node.key}
          image={remote}
          alt={alt}
          title={node.attributes.title}
          insideLink={Boolean(linkParent)}
          rejectedLink={Boolean(linkParent) && !linkOpens}
          labelStyle={labelStyle}
          styleMap={styleMap}
        />
      );
    }
    return (
      <Text key={node.key} style={labelStyle}>
        {alt || src}
      </Text>
    );
  },
};

function renderMarkdownLink(
  node: ASTNode,
  children: ReactNode[],
  styleMap: MarkdownStyleMap,
  block: boolean,
) {
  const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
  if (!href) return <Text key={node.key}>{children}</Text>;
  const image = soleRemoteImage(node);
  if (image) {
    return (
      <LinkedRemoteImage
        key={node.key}
        href={href}
        image={image.remote}
        alt={image.alt}
        title={image.title}
        styleMap={styleMap}
      />
    );
  }
  if (!block && isWebsiteLink(node)) {
    const text = astText(node);
    return (
      <NativeLink
        href={href}
        accessibilityLabel={text === undefined ? undefined : linkLabel(text, href)}
        key={node.key}
        style={styleMap.website_link}
      >
        <LinkFavicon href={href} plate={styleMap.link_favicon_plate} />
        {WORD_JOINER}
        {ISOLATE}
        {text === undefined ? (
          children
        ) : (
          <Text style={styleMap.website_link_label}>{linkLabel(text, href)}</Text>
        )}
        {POP_ISOLATE}
      </NativeLink>
    );
  }
  if (!block) {
    return (
      <NativeLink href={href} key={node.key} style={styleMap.link}>
        {children}
      </NativeLink>
    );
  }
  return (
    <NativeLink block href={href} key={node.key} style={styleMap.blocklink}>
      <View style={styleMap.image}>{children}</View>
    </NativeLink>
  );
}

function LinkedRemoteImage({
  href,
  image,
  alt,
  title,
  styleMap,
}: {
  href: string;
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  styleMap: MarkdownStyleMap;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <NativeLink block href={href} style={styleMap.blocklink}>
        <View style={styleMap.image}>
          <FitImage
            indicator
            style={styleMap._VIEW_SAFE_image}
            source={{ uri: image.href }}
            accessible={Boolean(alt)}
            accessibilityLabel={alt}
          />
        </View>
      </NativeLink>
    );
  }
  return (
    <View style={styleMap.linked_image}>
      <RemoteMarkdownImage
        image={image}
        alt={alt}
        title={title}
        rejectedLink={false}
        labelStyle={styleMap.plain_text}
        styleMap={styleMap}
        onLoad={() => setRevision((revision) => revision + 1)}
      />
      <NativeLink href={href} style={styleMap.link}>
        {linkHost(href)}
      </NativeLink>
    </View>
  );
}

export function RemoteMarkdownImage({
  image,
  alt,
  title,
  insideLink = false,
  rejectedLink,
  labelStyle,
  styleMap,
  onLoad,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  insideLink?: boolean;
  rejectedLink: boolean;
  labelStyle: MarkdownStyleMap[string] | undefined;
  styleMap: MarkdownStyleMap;
  onLoad?: () => void;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, rejectedLink)) {
    return (
      <FitImage
        indicator
        style={styleMap._VIEW_SAFE_image}
        source={{ uri: image.href }}
        accessible={Boolean(alt)}
        accessibilityLabel={alt}
      />
    );
  }
  if (rejectedLink || insideLink) return <Text style={labelStyle}>{alt || image.host}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={alt ? `${alt}, ${image.host}` : image.host}
      accessibilityHint={title}
      // A 32pt chip with 6pt slop on each side keeps the 44pt touch target.
      hitSlop={6}
      onPress={(event) => {
        event.preventDefault();
        event.stopPropagation();
        markRemoteImageLoaded(image.href);
        onLoad?.();
        setRevision((revision) => revision + 1);
      }}
      style={styleMap.image_placeholder}
    >
      <View style={styleMap.image_placeholder_icon} />
      {alt ? (
        <Text numberOfLines={1} style={styleMap.image_placeholder_alt}>
          {alt}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={styleMap.image_placeholder_host}>
        {image.host}
      </Text>
    </Pressable>
  );
}

type LinkifiedTextProps = {
  children: string;
  color: string;
  linkColor: string;
  palette: ColorTokens;
};

export const LinkifiedText = memo(function LinkifiedText({
  children,
  color,
  linkColor,
  palette,
}: LinkifiedTextProps) {
  const openLink = useNativeLinkConfirm();
  const labelStyle: TextStyle = {
    color,
    fontWeight: "500",
    textDecorationLine: "underline",
    textDecorationColor: palette.mutedForeground,
  };
  return (
    <Text
      style={[
        { color, fontSize: BODY_FONT_SIZE, lineHeight: 23 },
        contraryDirection(children) && layout.farSideText,
      ]}
    >
      {plainTextLinkParts(children).map((part, index) => {
        if (part.type === "text") return part.value;
        const open = () => {
          openLink(part.href);
        };
        if (!linkFaviconOrigin(part.href)) {
          return (
            <Text
              accessibilityRole="link"
              key={index}
              style={{ color: linkColor, textDecorationLine: "underline" }}
              onPress={open}
            >
              {part.value}
            </Text>
          );
        }
        const label = linkLabel(part.value, part.href);
        return (
          <Text
            accessibilityRole="link"
            accessibilityLabel={label}
            key={index}
            style={{ color, fontWeight: "500" }}
            onPress={open}
          >
            <LinkFavicon
              href={part.href}
              plate={{ backgroundColor: palette.faviconPlate, padding: 2 }}
            />
            {WORD_JOINER}
            {ISOLATE}
            <Text style={labelStyle}>{label}</Text>
            {POP_ISOLATE}
          </Text>
        );
      })}
    </Text>
  );
});

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const openLink = useNativeLinkConfirm();
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const sharedProps = {
    colorScheme,
    markdownit: markdownParser,
    style: styles,
    rules: renderRules,
    onLinkPress: (url: string) => {
      openLink(url);
      return false;
    },
  };

  return (
    <OpenLinkContext.Provider value={openLink}>
      <View style={layout.wrap}>
        <LinkFaviconsPausedContext.Provider value={streaming}>
          {streaming ? (
            <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
              {children}
            </MarkdownStream>
          ) : (
            <Markdown {...sharedProps}>{children}</Markdown>
          )}
        </LinkFaviconsPausedContext.Provider>
      </View>
    </OpenLinkContext.Provider>
  );
});

const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  // Deliberately no `flex: 1`: an automatic basis gives the item its text's natural width.
  listContent: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  reversedRow: {
    flexDirection: "row-reverse",
  },
  // React Native mirrors `right` in a right-to-left app, so it is always the far side.
  farSideText: {
    textAlign: "right",
  },
  // A text group sits in a row; filling it lets a short line reach the far side too.
  farSideBlock: {
    textAlign: "right",
    width: "100%",
  },
  // An inline view sits on the baseline; this drops it so it centres on the capitals. The gap
  // before the label is part of the view, since inline views do not keep their margins.
  linkMarker: {
    width: LINK_TILE_SIZE + 4,
    height: LINK_TILE_SIZE,
    transform: [{ translateY: (LINK_TILE_SIZE - BODY_FONT_SIZE * 0.7) / 2 }],
  },
  linkTile: {
    width: LINK_TILE_SIZE,
    height: LINK_TILE_SIZE,
    padding: 1,
    borderRadius: 5,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  linkIcon: {
    width: "100%",
    height: "100%",
  },
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export { LinkFaviconsContext, RemoteImagesContext } from "./markdown";

export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
