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
import { createContext, memo, useContext, useMemo, useState } from "react";
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import {
  inlineMarkdownImageSrc,
  linkifyExplicitUrls,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
} from "./markdown";

function keepMarkdownLinkToken(_url: string) {
  return true;
}

const BLOCK_GAP = 10;

// One shared parser: the Markdown components memoize on its identity.
const markdownParser = createMarkdownIt();
markdownParser.validateLink = keepMarkdownLinkToken;
linkifyExplicitUrls(markdownParser);

function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      fontSize: 15.5,
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

function openMarkdownLink(href: string, event: { defaultPrevented: boolean }) {
  if (event.defaultPrevented) return;
  void openSafeLink(href);
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
  const marker: TextStyle = {
    color: body?.color,
    fontSize: body?.fontSize,
    lineHeight: body?.lineHeight,
  };
  // `parent` lists ancestors nearest first; the nearest list decides the marker, so an ordered
  // list nested in a bulleted one is numbered.
  const list = parent.find(
    (ancestor) => ancestor.type === "bullet_list" || ancestor.type === "ordered_list",
  );
  if (list?.type === "bullet_list") {
    return (
      <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
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
      <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
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
  if (!block) {
    return (
      <Text
        accessibilityRole="link"
        key={node.key}
        style={styleMap.link}
        onPress={(event) => openMarkdownLink(href, event)}
      >
        {children}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      key={node.key}
      onPress={(event) => openMarkdownLink(href, event)}
      style={styleMap.blocklink}
    >
      <View style={styleMap.image}>{children}</View>
    </Pressable>
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
      <Pressable
        accessibilityRole="link"
        onPress={() => {
          void openSafeLink(href);
        }}
        style={styleMap.blocklink}
      >
        <View style={styleMap.image}>
          <FitImage
            indicator
            style={styleMap._VIEW_SAFE_image}
            source={{ uri: image.href }}
            accessible={Boolean(alt)}
            accessibilityLabel={alt}
          />
        </View>
      </Pressable>
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
      <Text
        accessibilityRole="link"
        style={styleMap.link}
        onPress={() => {
          void openSafeLink(href);
        }}
      >
        {linkHost(href)}
      </Text>
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
};

export const LinkifiedText = memo(function LinkifiedText({
  children,
  color,
  linkColor,
}: LinkifiedTextProps) {
  return (
    <Text style={{ color, fontSize: 15.5, lineHeight: 23 }}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : (
          <Text
            accessibilityRole="link"
            key={index}
            style={{ color: linkColor, textDecorationLine: "underline" }}
            onPress={() => {
              void openSafeLink(part.href);
            }}
          >
            {part.value}
          </Text>
        ),
      )}
    </Text>
  );
});

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const sharedProps = {
    colorScheme,
    markdownit: markdownParser,
    style: styles,
    rules: renderRules,
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
  // Deliberately no `flex: 1`: an automatic basis gives the item its text's natural width.
  listContent: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
});

export type { ChatMarkdownProps } from "./markdown";
export { RemoteImagesContext } from "./markdown";
