// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EnrichedMarkdownTextProps,
  MarkdownCodeBlock,
  MarkdownImageBlock,
  MarkdownImageOccurrence,
  MarkdownLinkOccurrence,
} from "react-native-enriched-markdown";
import { describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => vi.fn());

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

const i18n = vi.hoisted(() => ({ isRTL: false }));

// The module's Text, which the app replaces with a capped one after this package has loaded.
const reactNativeText = vi.hoisted(() => ({ current: undefined as unknown }));

// The handlers of the code scroll view, so a test can report its measured sizes.
const scrollEvents = vi.hoisted(() => ({
  onLayout: undefined as
    | ((event: { nativeEvent: { layout: { width: number; height: number } } }) => void)
    | undefined,
  onStartShouldSetResponder: undefined as (() => boolean) | undefined,
  onContentSizeChange: undefined as ((width: number, height: number) => void) | undefined,
}));

// The props the native Markdown view last received, and how many times it mounted.
const enriched = vi.hoisted(() => ({
  props: undefined as EnrichedMarkdownTextProps | undefined,
  mounts: 0,
}));

// react-native ships uncompiled Flow source that node cannot load, so tests mock
// its component surface as marker elements that expose the style props the
// code and image views set.
vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const flattenStyle = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flattenStyle))
      : ((style ?? {}) as Record<string, unknown>);

  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  const mockComponent = (tag: string, dataKeys: string[] = [], booleanKeys: string[] = []) =>
    function MockNativeComponent(props: Record<string, unknown>) {
      const {
        children,
        style,
        onPress,
        onLongPress,
        onAccessibilityAction: _onAccessibilityAction,
        ...rest
      } = props;
      const flattened = flattenStyle(style);
      const data: Record<string, unknown> = {};
      for (const key of dataKeys) {
        const value = rest[key] ?? flattened[key];
        if (value !== undefined && value !== null && value !== false) {
          data[`data-${kebab(key)}`] =
            value === true ? "true" : Array.isArray(value) ? value.join(" ") : value;
        }
      }
      for (const key of booleanKeys) {
        if (typeof rest[key] === "boolean") data[`data-${kebab(key)}`] = String(rest[key]);
      }
      if (tag === "rn-view" && typeof rest.onLayout === "function") {
        scrollEvents.onLayout = rest.onLayout as typeof scrollEvents.onLayout;
      }
      if (tag === "rn-view" && typeof rest.onStartShouldSetResponder === "function") {
        scrollEvents.onStartShouldSetResponder =
          rest.onStartShouldSetResponder as typeof scrollEvents.onStartShouldSetResponder;
        delete rest.onStartShouldSetResponder;
      }
      for (const key of [
        "onResponderGrant",
        "onResponderMove",
        "onResponderRelease",
        "onResponderTerminate",
        "onResponderTerminationRequest",
      ]) {
        delete rest[key];
      }
      if (tag === "rn-image") {
        delete rest.onLoad;
        delete rest.onError;
      }
      if (tag === "rn-scroll-view" && typeof rest.onContentSizeChange === "function") {
        scrollEvents.onContentSizeChange =
          rest.onContentSizeChange as typeof scrollEvents.onContentSizeChange;
        delete rest.onContentSizeChange;
      }
      return createElement(
        tag,
        {
          ...rest,
          ...data,
          onContextMenu: onLongPress,
          onClick:
            typeof onPress === "function"
              ? (event: { preventDefault(): void; stopPropagation(): void }) => {
                  (onPress as (pressEvent: typeof event) => void)(event);
                }
              : undefined,
        },
        children as ReactNode,
      );
    };

  reactNativeText.current = mockComponent("rn-text", [
    "accessibilityRole",
    "accessibilityLabel",
    "textDecorationLine",
    "textDecorationColor",
    "color",
    "fontWeight",
    "fontFamily",
    "fontSize",
    "lineHeight",
    "backgroundColor",
    "borderWidth",
    "textAlign",
    "writingDirection",
    "maxFontSizeMultiplier",
  ]);

  return {
    View: mockComponent("rn-view", [
      "backgroundColor",
      "borderWidth",
      "borderRadius",
      "flexDirection",
      "accessibilityElementsHidden",
      "importantForAccessibility",
      "accessibilityRole",
    ]),
    get Text() {
      return reactNativeText.current;
    },
    ScrollView: mockComponent(
      "rn-scroll-view",
      ["horizontal"],
      ["scrollEnabled", "showsHorizontalScrollIndicator", "showsVerticalScrollIndicator"],
    ),
    Pressable: mockComponent("rn-pressable", ["accessibilityRole", "backgroundColor"]),
    TextInput: mockComponent("rn-text-input"),
    Image: mockComponent("rn-image"),
    Animated: {
      View: mockComponent("rn-animated-view"),
      createAnimatedComponent: (component: unknown) => component,
      timing: () => ({ start: () => undefined }),
      sequence: (...animations: unknown[]) => animations,
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      delay: () => ({}),
      Value: class {},
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFillObject: {},
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default ?? options.android,
    },
    Linking: linking,
    Alert: { alert },
    I18nManager: i18n,
    useColorScheme: () => "dark",
    useWindowDimensions: () => ({ fontScale: 1 }),
  };
});

// The native view draws text itself. The stand-in records its props and, like the library,
// hands each code block and image paragraph to `renderers`, drawing what they return.
vi.mock("react-native-enriched-markdown", async () => {
  const { createElement, Fragment, useEffect } = await import("react");
  const { createMarkdownIt } = await import("@ronradtke/react-native-markdown-display");
  const parser = createMarkdownIt();
  type Token = {
    type: string;
    info: string;
    content: string;
    children: Token[] | null;
    attrGet(name: string): string | null;
  };

  function blocks(markdown: string): (MarkdownCodeBlock | MarkdownImageBlock)[] {
    const tokens: Token[] = parser.parse(markdown, {});
    return tokens.flatMap((token, index): (MarkdownCodeBlock | MarkdownImageBlock)[] => {
      const id = `block-${index}`;
      if (token.type === "fence" || token.type === "code_block") {
        return [
          {
            kind: "code",
            id,
            placement: "root",
            language: token.info.trim().split(/\s+/)[0] ?? "",
            code: token.content.replace(/\n+$/, ""),
            isComplete: true,
          },
        ];
      }
      if (token.type !== "inline" || tokens[index - 1]?.type !== "paragraph_open") return [];
      const [image, ...rest] = (token.children ?? []).filter(
        (child) => !(child.type === "text" && !child.content.trim()),
      );
      if (image?.type !== "image" || rest.length > 0) return [];
      return [
        {
          kind: "image",
          id,
          placement: "root",
          url: image.attrGet("src") ?? "",
          altText: image.content,
          title: image.attrGet("title") ?? "",
          occurrenceId: `${id}-image`,
        },
      ];
    });
  }

  function EnrichedMarkdownText(props: EnrichedMarkdownTextProps) {
    enriched.props = props;
    useEffect(() => {
      enriched.mounts += 1;
    }, []);
    return createElement(
      "enriched-markdown",
      null,
      blocks(props.markdown).map((block) =>
        createElement(
          Fragment,
          { key: block.id },
          (block.kind === "code"
            ? props.renderers?.code?.(block)
            : props.renderers?.image?.(block)) ??
            createElement("native-block", { "data-kind": block.kind }),
        ),
      ),
    );
  }

  return { EnrichedMarkdownText };
});

import { darkTokens, lightTokens, MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { themes } from "prism-react-renderer";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { TextProps } from "react-native";
import { Pressable } from "react-native";
import type { LinkFavicons, MentionLink, MermaidDiagramProps } from "./markdown.native";
import {
  ChatMarkdown,
  CodeCopyButtonContext,
  LinkFaviconsContext,
  LinkifiedText,
  MarkdownLinkPromptProvider,
  MermaidDiagramContext,
  markdownCodeBlocks,
  RemoteImagesContext,
} from "./markdown.native";
import { RemoteMarkdownImage } from "./native/images";
import { textBlocks } from "./native/linkified-text";
import { markdownStyles } from "./native/styles";

// The data attributes of the innermost text element holding exactly `content`.
function textStyle(html: string, content: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const text = [...document.querySelectorAll("rn-text")]
    .reverse()
    .find((element) => element.textContent === content);
  if (!text) throw new Error(`no text "${content}"`);
  return Object.fromEntries(
    [...text.attributes]
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((a) => [a.name, a.value]),
  );
}

function nativeProps(): EnrichedMarkdownTextProps {
  if (!enriched.props) throw new Error("the native view never rendered");
  return enriched.props;
}

async function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => {
    await act(async () => {
      root.render(next);
    });
  };
  await render(node);
  return {
    container,
    render,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const link = (url: string, label = url): MarkdownLinkOccurrence => ({ url, label, title: "" });

/** As the native view does once it has parsed the document's links. */
async function reportLinks(links: MarkdownLinkOccurrence[]) {
  await act(async () => {
    nativeProps().onLinksChange?.(links);
  });
}

async function pressLink(url: string) {
  await act(async () => {
    nativeProps().onLinkPress?.({ url });
  });
}

/** The style the native view gives this URL: the first variant whose pattern matches. */
function variantFor(url: string) {
  return Object.entries(nativeProps().markdownStyle?.linkVariants ?? {}).find(([pattern]) =>
    new RegExp(pattern).test(url),
  )?.[1];
}

const image = (url: string, placement: MarkdownImageOccurrence["placement"] = "inline") => ({
  id: url,
  url,
  altText: "",
  title: "",
  placement,
});

describe("native markdown view", () => {
  it("hands the message to the native view, animating it while it streams", () => {
    renderToStaticMarkup(<ChatMarkdown streaming>{"Partial **reply"}</ChatMarkdown>);
    expect(nativeProps()).toMatchObject({
      markdown: "Partial **reply",
      flavor: "github",
      streamingAnimation: true,
    });
    renderToStaticMarkup(<ChatMarkdown>{"Done."}</ChatMarkdown>);
    expect(nativeProps().streamingAnimation).toBe(false);
  });
});

const codeBlock = (code: string, language = ""): MarkdownCodeBlock => ({
  kind: "code",
  id: "code",
  placement: "root",
  code,
  language,
  isComplete: true,
});

// Stands in for the app's copy button, recording the code it would copy.
function CopyProbe({ code }: { code: string }) {
  return createElement("copy-probe", { "data-code": code });
}

// Stands in for the app's WebView, recording what the renderer hands it.
function ProbeDiagram({ source, palette, colorScheme, fallback }: MermaidDiagramProps) {
  return createElement(
    "diagram-probe",
    { "data-source": source, "data-scheme": colorScheme, "data-foreground": palette.foreground },
    fallback,
  );
}

describe("native markdown code blocks", () => {
  it.each([
    ["a fence", "```ts\nconst a = 1;\n```"],
    ["a fence without a language", "```\nnpm install\n```"],
    ["an indented block", "Run:\n\n    npm test"],
    ["a mermaid fence the app cannot draw", "```mermaid\ngraph LR\n  A --> B\n```"],
  ])("leaves %s to the native view", (_case, markdown) => {
    const html = renderToStaticMarkup(
      <CodeCopyButtonContext.Provider value={CopyProbe}>
        <ChatMarkdown>{markdown}</ChatMarkdown>
      </CodeCopyButtonContext.Provider>,
    );
    expect(html).toContain('<native-block data-kind="code">');
    expect(html).not.toContain("<rn-scroll-view");
    // The native view draws its own copy control.
    expect(html).not.toContain("<copy-probe");
  });

  it("keeps native code blocks from offering to wrap", () => {
    renderToStaticMarkup(<ChatMarkdown>{"```ts\nconst a = 1;\n```"}</ChatMarkdown>);
    expect(nativeProps().enableCodeBlockWrapToggle).toBe(false);
    expect(nativeProps().renderers?.code?.(codeBlock("const a = 1;", "ts"))).toBeUndefined();
    expect(nativeProps().renderers?.code?.(codeBlock("npm test"))).toBeUndefined();
  });

  it("lists the code of every fenced and indented block, and nothing else", () => {
    const markdown = [
      "Run `npm test` first.",
      "```ts\nconst a = 1;\n\n  return a;\n```",
      "```\n```",
      "> ```\n> quoted\n> ```",
      "- item\n\n      indented in a list",
      "```mermaid\ngraph LR\n  A --> B\n```",
      "```text\nDear team,\n```",
    ].join("\n\n");
    expect(markdownCodeBlocks(markdown)).toEqual([
      "const a = 1;\n\n  return a;",
      "quoted",
      "indented in a list",
      "graph LR\n  A --> B",
      "Dear team,",
    ]);
    expect(markdownCodeBlocks("No code here, only `inline`.")).toEqual([]);
    expect(markdownCodeBlocks("```ts\n\n\n```")).toEqual([]);
  });
});

describe("native markdown prose fences", () => {
  const draft =
    "Dear team, this line of prose is far wider than a bubble, so it wraps instead of scrolling.";

  function renderProse(markdown: string, props: { streaming?: boolean } = {}) {
    return renderToStaticMarkup(
      <CodeCopyButtonContext.Provider value={CopyProbe}>
        <ChatMarkdown palette={lightTokens} colorScheme="light" {...props}>
          {markdown}
        </ChatMarkdown>
      </CodeCopyButtonContext.Provider>,
    );
  }

  it.each(["text", "txt", "plaintext", "Text"])(
    "wraps a fence marked %j as prose in the body font",
    (language) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown palette={lightTokens} colorScheme="light">
          {`\`\`\`${language}\n${draft}\n\`\`\``}
        </ChatMarkdown>,
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      // No sideways scroll view: the line wraps inside the fence's card.
      expect(document.querySelector("rn-scroll-view")).toBeNull();
      expect(document.querySelector("native-block")).toBeNull();
      expect(
        document.querySelector(`[data-background-color="${lightTokens.secondary}"]`),
      ).not.toBeNull();
      expect(textStyle(html, draft)).toMatchObject({
        "data-color": lightTokens.foreground,
        "data-font-size": "17",
        "data-line-height": "22",
      });
      expect(textStyle(html, draft)["data-font-family"]).toBeUndefined();
    },
  );

  it("preserves a prose fence's lines and blank lines", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown colorScheme="light">
        {"```text\nDear team,\n\n  see you Monday.\n```"}
      </ChatMarkdown>,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const lines = [...document.querySelectorAll("rn-text")]
      .filter((text) => !text.querySelector("rn-view"))
      .map((text) => text.textContent);
    expect(lines).toEqual(["text", "Dear team,", " ", "  see you Monday."]);
  });

  it("gives a prose fence a copy button for its exact code, outside any scroll view", () => {
    const code = "Dear team,\n\n  see you Monday.";
    const document = new DOMParser().parseFromString(
      renderProse(`\`\`\`text\n${code}\n\`\`\``),
      "text/html",
    );
    const probes = document.querySelectorAll("copy-probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.getAttribute("data-code")).toBe(code);
    expect(probes[0]?.closest("rn-scroll-view")).toBeNull();
    // The button sits inside the fence's frame, beside the prose.
    const frame = probes[0]?.parentElement?.parentElement;
    expect(frame?.getAttribute("data-border-width")).toBeTruthy();
    expect(frame?.getAttribute("data-background-color")).toBe(lightTokens.secondary);
  });

  it("shows the button while a reply streams, and none for an empty fence or without one", () => {
    expect(renderProse("```text\nDear team,", { streaming: true })).toContain("<copy-probe");
    expect(renderProse("```text\n\n\n```")).not.toContain("<copy-probe");
    const html = renderToStaticMarkup(<ChatMarkdown>{"```text\nDear team,\n```"}</ChatMarkdown>);
    expect(html).not.toContain("<copy-probe");
    expect(html).toContain("Dear team,");
  });

  it("draws prose with the Text the app installs after this package loads", () => {
    // As the app's text-size cap does when it starts.
    const original = reactNativeText.current as (props: TextProps) => ReactNode;
    reactNativeText.current = (props: TextProps) =>
      createElement(original, { ...props, maxFontSizeMultiplier: MAX_FONT_SCALE });
    try {
      const html = renderToStaticMarkup(<ChatMarkdown>{"```text\nDear team,\n```"}</ChatMarkdown>);
      expect(textStyle(html, "Dear team,")["data-max-font-size-multiplier"]).toBe(
        String(MAX_FONT_SCALE),
      );
    } finally {
      reactNativeText.current = original;
    }
  });

  it("aligns each prose line by its own direction, like a paragraph", () => {
    const align = (markdown: string, line: string) =>
      textStyle(
        renderToStaticMarkup(<ChatMarkdown colorScheme="light">{markdown}</ChatMarkdown>),
        line,
      )["data-text-align"];
    expect(align("```text\nשלום רב.\nDear team,\n```", "שלום רב.")).toBe("right");
    expect(align("```text\nשלום רב.\nDear team,\n```", "Dear team,")).toBeUndefined();
    i18n.isRTL = true;
    try {
      // React Native mirrors `right` in a right-to-left layout, so it lands on the left.
      expect(align("```text\nDear team,\n```", "Dear team,")).toBe("right");
      expect(align("```text\nשלום רב.\n```", "שלום רב.")).toBeUndefined();
    } finally {
      i18n.isRTL = false;
    }
  });
});

describe("native markdown diagrams", () => {
  const SOURCE = "graph LR\n  A[Clone] --> B[Branch]";
  const FLOW = `\`\`\`mermaid\n${SOURCE}\n\`\`\``;

  function renderWithDiagrams(
    markdown: string,
    props: { streaming?: boolean; colorScheme?: "light" | "dark" } = {},
  ) {
    const { colorScheme = "light", ...rest } = props;
    return renderToStaticMarkup(
      <MermaidDiagramContext.Provider value={ProbeDiagram}>
        <CodeCopyButtonContext.Provider value={CopyProbe}>
          <ChatMarkdown
            palette={colorScheme === "light" ? lightTokens : darkTokens}
            colorScheme={colorScheme}
            {...rest}
          >
            {markdown}
          </ChatMarkdown>
        </CodeCopyButtonContext.Provider>
      </MermaidDiagramContext.Provider>,
    );
  }

  it("hands a mermaid fence to the app's diagram with its code block as the fallback", () => {
    const html = renderWithDiagrams(FLOW);
    const document = new DOMParser().parseFromString(html, "text/html");
    const probe = document.querySelector("diagram-probe");
    expect(probe?.getAttribute("data-source")).toBe(SOURCE);
    expect(probe?.getAttribute("data-scheme")).toBe("light");
    expect(probe?.getAttribute("data-foreground")).toBe(lightTokens.foreground);
    expect(probe?.textContent).toContain("A[Clone] --> B[Branch]");
    expect(document.querySelector("native-block")).toBeNull();
  });

  it("gives the fallback code a copy button for its exact code, beside its scroll view", () => {
    const document = new DOMParser().parseFromString(renderWithDiagrams(FLOW), "text/html");
    const probe = document.querySelector("diagram-probe copy-probe");
    expect(probe?.getAttribute("data-code")).toBe(SOURCE);
    expect(probe?.closest("rn-scroll-view")).toBeNull();
    const row = probe?.parentElement;
    expect(row?.getAttribute("data-flex-direction")).toBe("row");
    expect(row?.querySelector("rn-scroll-view")).not.toBeNull();
    const frame = row?.parentElement;
    expect(frame?.getAttribute("data-border-width")).toBeTruthy();
    expect(frame?.getAttribute("data-background-color")).toBe(lightTokens.secondary);
  });

  it.each([
    ["dark", darkTokens, themes.oneDark],
    ["light", lightTokens, themes.oneLight],
  ] as const)("draws the fallback in the %s theme, filled once", (scheme, palette, theme) => {
    const html = renderWithDiagrams("```mermaid\nplain text\n```", { colorScheme: scheme });
    const document = new DOMParser().parseFromString(html, "text/html");
    const rows = document.querySelectorAll("rn-scroll-view rn-view[data-flex-direction='row']");
    expect([...rows].map((row) => row.textContent)).toEqual(["plain text"]);
    const token = rows[0]?.querySelector("rn-text");
    expect(token?.getAttribute("data-color")).toBe(theme.plain.color);
    expect(token?.getAttribute("data-font-family")).toBe("ui-monospace");
    expect(token?.getAttribute("data-font-size")).toBe("14");
    expect(token?.hasAttribute("data-line-height")).toBe(false);
    expect(html.split(`data-background-color="${palette.secondary}"`)).toHaveLength(2);
  });

  it("scrolls a fallback with a line wider than the bubble", async () => {
    const line =
      'graph LR\n  A["a label far wider than the bubble, so the code scrolls sideways"] --> B';
    scrollEvents.onContentSizeChange = undefined;
    const view = await mount(
      <MermaidDiagramContext.Provider value={ProbeDiagram}>
        <ChatMarkdown>{`\`\`\`mermaid\n${line}\n\`\`\``}</ChatMarkdown>
      </MermaidDiagramContext.Provider>,
    );
    await act(async () => {
      scrollEvents.onLayout?.({ nativeEvent: { layout: { width: 200, height: 40 } } });
      scrollEvents.onContentSizeChange?.(900, 40);
    });
    const scrollView = view.container.querySelector("rn-scroll-view");
    expect(scrollView?.getAttribute("data-horizontal")).toBe("true");
    expect(scrollView?.getAttribute("data-scroll-enabled")).toBe("true");
    expect(scrollEvents.onStartShouldSetResponder?.()).toBe(true);
    await view.cleanup();
  });

  it.each([
    [
      "without a diagram from the app",
      () => renderToStaticMarkup(<ChatMarkdown>{FLOW}</ChatMarkdown>),
    ],
    ["while the reply streams", () => renderWithDiagrams(FLOW, { streaming: true })],
    ["for an empty mermaid fence", () => renderWithDiagrams("```mermaid\n\n```")],
    ["for other fences", () => renderWithDiagrams("```ts\nconst a = 1;\n```")],
  ])("leaves the code to the native view %s", (_case, render) => {
    const html = render();
    expect(html).not.toContain("<diagram-probe");
    expect(html).toContain('<native-block data-kind="code">');
  });
});

describe("native markdown images", () => {
  it("shows a remote image as a placeholder that loads it in place on tap", async () => {
    const markdown = '![chart](https://images.example.test/tap.png?d=secret "Q3 revenue")';
    const html = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(html).not.toContain("<rn-stub");
    expect(html).toContain('data-accessibility-role="button"');
    expect(html).toContain('accessibilityLabel="chart, images.example.test"');
    expect(html).toContain('accessibilityHint="Q3 revenue"');
    // A filled chip on the muted bubble reads as a control in both themes.
    expect(html).toContain(`data-background-color="${darkTokens.background}"`);

    linking.openURL.mockClear();
    const view = await mount(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(view.container.querySelector("rn-stub")).toBeNull();
    await act(async () => {
      view.container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(view.container.querySelector("rn-stub")).not.toBeNull();
    expect(view.container.querySelector("[data-accessibility-role='button']")).toBeNull();
    expect(linking.openURL).not.toHaveBeenCalled();
    await view.cleanup();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain("<rn-stub");
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    const styles = markdownStyles(darkTokens);
    const remote = (href: string) => (
      <RemoteMarkdownImage
        image={{ href, host: "images.example.test" }}
        alt="chart"
        styles={styles}
      />
    );
    const view = await mount(remote("https://images.example.test/native-first.png"));
    await act(async () => {
      view.container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(view.container.querySelector("rn-stub")).not.toBeNull();

    await view.render(remote("https://images.example.test/native-second.png"));
    expect(view.container.querySelector("rn-stub")).toBeNull();
    expect(view.container.querySelector("[data-accessibility-role='button']")).not.toBeNull();
    await view.cleanup();
  });

  it("loads remote images at once when the reader turned that on", async () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>{"![chart](https://images.example.test/auto.png)"}</ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html).toContain("<rn-stub");
    expect(html).not.toContain('data-accessibility-role="button"');
    for (const placement of ["inline", "list", "table", "link"] as const) {
      await expect(
        Promise.resolve(
          nativeProps().resolveImageSource?.(
            image("https://badge.example.test/auto.svg", placement),
          ),
        ),
      ).resolves.toEqual({ uri: "https://badge.example.test/auto.svg" });
    }
  });

  it("never requests an image inside text until the reader allows remote images", async () => {
    renderToStaticMarkup(
      <ChatMarkdown>{"See ![build](https://badge.example.test/b.svg) now"}</ChatMarkdown>,
    );
    const resolve = nativeProps().resolveImageSource;
    for (const url of [
      "https://badge.example.test/b.svg",
      "/api/v1/p.gif",
      "example.test/p.gif",
      "mailto:user@example.test",
      "tel:+15551212",
      "javascript:alert(1)",
    ]) {
      await expect(Promise.resolve(resolve?.(image(url)))).rejects.toThrow(
        "Remote image not allowed",
      );
    }
  });

  it("lets an image inside text load once the reader tapped the same image", async () => {
    const url = "https://images.example.test/tapped-then-inline.png";
    const view = await mount(<ChatMarkdown>{`![chart](${url})`}</ChatMarkdown>);
    await expect(
      Promise.resolve(nativeProps().resolveImageSource?.(image(url, "list"))),
    ).rejects.toThrow();
    await act(async () => {
      view.container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    await expect(
      Promise.resolve(nativeProps().resolveImageSource?.(image(url, "list"))),
    ).resolves.toEqual({ uri: url });
    await view.cleanup();
  });

  it("starts the native view over when the reader turns remote images on", async () => {
    const markdown = "See ![build](https://badge.example.test/remount.svg)";
    const view = await mount(<ChatMarkdown>{markdown}</ChatMarkdown>);
    const mounts = enriched.mounts;
    await view.render(<ChatMarkdown>{`${markdown} now`}</ChatMarkdown>);
    expect(enriched.mounts).toBe(mounts);
    await view.render(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>{`${markdown} now`}</ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(enriched.mounts).toBe(mounts + 1);
    await view.cleanup();
  });

  it("leaves embedded image data and unopenable sources to the native view", async () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"![dot](data:image/png;base64,iVBORw0KGgo=)\n\n![logo](/api/v1/p.gif)"}
      </ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("data-accessibility-role");
    expect(html.match(/<native-block data-kind="image">/g)).toHaveLength(2);
    // Embedded data loads as written; nothing else does.
    expect(
      nativeProps().resolveImageSource?.(image("data:image/png;base64,iVBORw0KGgo=")),
    ).toBeUndefined();
  });
});

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const globe = createElement("rn-globe");

function withFavicons(favicons: LinkFavicons, node: ReactNode) {
  return <LinkFaviconsContext.Provider value={favicons}>{node}</LinkFaviconsContext.Provider>;
}

describe("native website links", () => {
  it("keeps a link's own text and shortens a bare URL to host and path", async () => {
    const view = await mount(
      withFavicons(
        { load: async () => ({ icon: null }), globe },
        <ChatMarkdown>
          {
            "[Post](https://native-a.example.test/p/1) https://www.native-b.example.test/status/9?s=1"
          }
        </ChatMarkdown>,
      ),
    );
    await reportLinks([
      link("https://native-a.example.test/p/1", "Post"),
      link("https://www.native-b.example.test/status/9?s=1"),
    ]);
    expect(nativeProps().linkPillContent).toEqual({
      "https://native-a.example.test/p/1": {},
      "https://www.native-b.example.test/status/9?s=1": { label: "native-b.example.test/status/9" },
    });
    expect(variantFor("https://native-a.example.test/p/1")).toEqual(
      expect.objectContaining({ pill: expect.any(Object), color: darkTokens.foreground }),
    );
    await view.cleanup();
  });

  it("keeps a link's own text when the same address is also written bare", async () => {
    const view = await mount(
      withFavicons(
        { load: async () => ({ icon: null }), globe },
        <ChatMarkdown>
          {"[Docs](https://native-z.example.test/a) https://native-z.example.test/a"}
        </ChatMarkdown>,
      ),
    );
    await reportLinks([
      link("https://native-z.example.test/a", "Docs"),
      link("https://native-z.example.test/a"),
    ]);
    expect(nativeProps().linkPillContent).toEqual({ "https://native-z.example.test/a": {} });
    await view.cleanup();
  });

  it("shortens and cleans bare URLs whose escapes the parser decoded", async () => {
    const view = await mount(
      withFavicons(
        { load: async () => ({ icon: null }), globe },
        <ChatMarkdown>{"See the files"}</ChatMarkdown>,
      ),
    );
    const bidi = "https://bidi.example.test/%E2%80%AEtxt.exe";
    const cafe = "https://native-k.example.test/caf%C3%A9";
    await reportLinks([link(bidi), link(cafe, "https://native-k.example.test/café")]);
    expect(nativeProps().linkPillContent?.[bidi]?.label).toBe("bidi.example.test/txt.exe");
    expect(nativeProps().linkPillContent?.[cafe]?.label).toBe("native-k.example.test/café");
    await view.cleanup();
  });

  it("adds the site's icon once the API answers, asking once per site", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await mount(withFavicons({ load, globe }, <ChatMarkdown>{"Links"}</ChatMarkdown>));
    const first = "https://native-c.example.test/one";
    const second = "https://native-c.example.test/two";
    await reportLinks([link(first, "One"), link(second, "Two")]);
    await vi.waitFor(() => {
      expect(nativeProps().linkPillContent).toEqual({
        [first]: { iconUri: ICON },
        [second]: { iconUri: ICON },
      });
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("https://native-c.example.test");
    await view.cleanup();
  });

  it("shows no icon and does not ask again right away after a failed lookup", async () => {
    const load = vi.fn(async () => {
      throw new Error("Not found");
    });
    const links = [link("https://native-i.example.test/", "A")];
    const first = await mount(withFavicons({ load, globe }, <ChatMarkdown>{"[A]"}</ChatMarkdown>));
    await reportLinks(links);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(nativeProps().linkPillContent).toEqual({
      "https://native-i.example.test/": {},
    });
    await first.cleanup();

    const again = await mount(withFavicons({ load, globe }, <ChatMarkdown>{"[A]"}</ChatMarkdown>));
    await reportLinks(links);
    expect(nativeProps().linkPillContent).toEqual({
      "https://native-i.example.test/": {},
    });
    expect(load).toHaveBeenCalledTimes(1);
    await again.cleanup();
  });

  it("asks for no icon while a reply streams", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const markdown = "Partial https://native-e.example.test/x";
    const view = await mount(
      withFavicons({ load, globe }, <ChatMarkdown streaming>{markdown}</ChatMarkdown>),
    );
    await reportLinks([link("https://native-e.example.test/x")]);
    expect(load).not.toHaveBeenCalled();
    expect(nativeProps().linkPillContent).toEqual({
      "https://native-e.example.test/x": { label: "native-e.example.test/x" },
    });
    await view.render(withFavicons({ load, globe }, <ChatMarkdown>{markdown}</ChatMarkdown>));
    expect(load).toHaveBeenCalledWith("https://native-e.example.test");
    await view.cleanup();
  });

  it("gives no pill or icon to links that are not websites", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await mount(withFavicons({ load, globe }, <ChatMarkdown>{"Links"}</ChatMarkdown>));
    const others = ["mailto:someone@example.com", "tel:+15555550100", "/docs", "page:page_1"];
    await reportLinks([...others.map((url) => link(url, "label")), link("rakazo-mention:bot_1")]);
    expect(nativeProps().linkPillContent).toEqual({});
    expect(load).not.toHaveBeenCalled();
    // Links that are not websites keep the plain link style.
    for (const url of others.slice(0, 2)) expect(variantFor(url)).toBeUndefined();
    expect(nativeProps().markdownStyle?.link).toMatchObject({ color: darkTokens.link });
    // Addresses the app will not open read as plain text.
    for (const url of ["/docs", "javascript:alert(1)", "ftp://example.test/f"]) {
      expect(variantFor(url)).toEqual({ color: darkTokens.foreground, underline: false });
    }
    expect(variantFor("HTTPS://native-a.example.test/")).toHaveProperty("pill");
    await view.cleanup();
  });
});

describe("native mention links", () => {
  it("colors a mention by its bot and opens it, and does nothing for a bot that is gone", async () => {
    const open = vi.fn();
    const mentionLink = (id: string): MentionLink | undefined =>
      id === "bot.1" ? { color: lightTokens.destructive, open } : undefined;
    alert.mockClear();
    linking.openURL.mockClear();
    const view = await mount(
      <ChatMarkdown mentionLink={mentionLink}>{"[Ada](rakazo-mention:bot.1)"}</ChatMarkdown>,
    );
    await reportLinks([
      link("rakazo-mention:bot.1", "Ada"),
      link("rakazo-mention:gone", "Old bot"),
    ]);
    expect(variantFor("rakazo-mention:bot.1")).toEqual({
      color: lightTokens.destructive,
      underline: false,
    });
    // Only its own URL takes the bot's color: the pattern is exact, dots included.
    expect(variantFor("rakazo-mention:botx1")?.color).toBe(darkTokens.foreground);
    expect(variantFor("rakazo-mention:gone")).toEqual({
      color: darkTokens.foreground,
      underline: false,
    });

    await pressLink("rakazo-mention:bot.1");
    expect(open).toHaveBeenCalledTimes(1);
    await pressLink("rakazo-mention:gone");
    expect(open).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
    await view.cleanup();
  });
});

describe("native markdown page links", () => {
  it("opens a page link with the handler, and leaves it plain without one", async () => {
    alert.mockClear();
    linking.openURL.mockClear();
    const openPage = vi.fn();
    const markdown = "See [Duplex voice](page:page_1) and [z](page:a/b)";
    const view = await mount(<ChatMarkdown onOpenPage={openPage}>{markdown}</ChatMarkdown>);
    expect(variantFor("page:page_1")).toMatchObject({ underline: true });
    await pressLink("page:page_1");
    expect(openPage).toHaveBeenCalledWith("page_1");
    await pressLink("page:a/b");
    await pressLink("javascript:alert(1)");
    expect(openPage).toHaveBeenCalledTimes(1);

    await view.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(variantFor("page:page_1")).toMatchObject({ underline: false });
    await pressLink("page:page_1");
    expect(openPage).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
    await view.cleanup();
  });
});

describe("native external link confirmation", () => {
  async function mountLinks(appOrigin?: string) {
    alert.mockClear();
    linking.openURL.mockClear();
    const body = <ChatMarkdown>{"Links"}</ChatMarkdown>;
    return mount(
      appOrigin ? (
        <MarkdownLinkPromptProvider appOrigin={appOrigin}>{body}</MarkdownLinkPromptProvider>
      ) : (
        body
      ),
    );
  }

  it("asks before an external link and leaves it closed on cancel", async () => {
    const view = await mountLinks();
    await pressLink("https://example.test/docs?x=1");
    expect(alert).toHaveBeenCalledWith(
      "Open external link?",
      "example.test\n\nhttps://example.test/docs?x=1",
      expect.any(Array),
      { cancelable: true },
    );
    expect(alert.mock.calls.at(-1)?.[2][0]).toMatchObject({ text: "Cancel", style: "cancel" });
    expect(linking.openURL).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("opens mailto and tel without asking", async () => {
    const view = await mountLinks();
    await pressLink("mailto:user@example.test");
    await pressLink("tel:+15551212");
    expect(alert).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("mailto:user@example.test");
      expect(linking.openURL).toHaveBeenCalledWith("tel:+15551212");
    });
    await view.cleanup();
  });

  it("opens a same-origin link without asking", async () => {
    const view = await mountLinks("https://app.example.test");
    await pressLink("https://app.example.test/threads/1");
    expect(alert).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://app.example.test/threads/1");
    });
    await view.cleanup();
  });

  it("ignores a link that is not safe to open", async () => {
    const view = await mountLinks();
    await pressLink("javascript:alert(1)");
    await pressLink("data:text/html,hi");
    expect(alert).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("shows a full long URL and opens it only on confirmation", async () => {
    const url = `https://example.test/${"a".repeat(10000)}`;
    const view = await mountLinks();
    await pressLink(url);
    const [title, message, buttons, options] = alert.mock.calls.at(-1)!;
    expect(title).toBe("Open external link?");
    expect(message).toBe(`example.test\n\n${url}`);
    expect(buttons.map((button: { text: string }) => button.text)).toEqual(["Cancel", "Open"]);
    expect(options).toEqual({ cancelable: true });
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      buttons[1].onPress();
    });
    expect(linking.openURL).toHaveBeenCalledWith(url);
    await view.cleanup();
  });
});

describe("native trusted link sites", () => {
  async function mountTrusted(trustedSites: string[], trustSite = vi.fn()) {
    alert.mockClear();
    linking.openURL.mockClear();
    return mount(
      <MarkdownLinkPromptProvider trustedSites={trustedSites} trustSite={trustSite}>
        <ChatMarkdown>{"[Docs](https://docs.example.test/a)"}</ChatMarkdown>
      </MarkdownLinkPromptProvider>,
    );
  }

  it("opens the link and trusts its site from the third button", async () => {
    const trustSite = vi.fn(async () => {
      throw new Error("offline");
    });
    const view = await mountTrusted([], trustSite);
    await pressLink("https://docs.example.test/a");
    const buttons = alert.mock.calls.at(-1)![2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons.map((button) => button.text)).toEqual([
      "Cancel",
      "Always open example.test",
      "Open",
    ]);
    await act(async () => {
      buttons[1]!.onPress?.();
    });
    // A failed save still opens the link.
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://docs.example.test/a");
    });
    expect(trustSite).toHaveBeenCalledWith("https://docs.example.test/a");
    await view.cleanup();
  });

  it("opens a link to a trusted site directly", async () => {
    const view = await mountTrusted(["example.test"]);
    await pressLink("https://docs.example.test/a");
    expect(alert).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://docs.example.test/a");
    });
    await view.cleanup();
  });
});

describe("long user messages", () => {
  const line = (index: number) => `Line ${index} ${"x".repeat(60)}`;

  it("keeps a short message whole", () => {
    expect(textBlocks("one\n\ntwo")).toEqual(["one\n\ntwo"]);
  });

  it.each([
    ["plain lines", Array.from({ length: 200 }, (_, i) => line(i)).join("\n")],
    [
      "blank lines between paragraphs",
      Array.from({ length: 120 }, (_, i) => line(i)).join("\n\n\n"),
    ],
    [
      "leading and trailing blank lines",
      `\n\n${Array.from({ length: 80 }, (_, i) => line(i)).join("\n")}\n\n`,
    ],
  ])("cuts %s at line breaks into pieces that join back exactly", (_case, text) => {
    const blocks = textBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join("\n")).toBe(text);
    for (const block of blocks.slice(0, -1)) {
      expect(block.endsWith("\n")).toBe(false);
      expect(block.length).toBeLessThan(1100);
    }
  });

  it("keeps a single long line whole", () => {
    const text = "y".repeat(5000);
    expect(textBlocks(text)).toEqual([text]);
  });

  it("draws a long message as stacked paragraphs with the same text and style", () => {
    const text = Array.from({ length: 60 }, (_, i) => `${line(i)} https://example.com/${i}`).join(
      "\n",
    );
    const html = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {text}
      </LinkifiedText>,
    );
    const root = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
    expect(root?.tagName.toLowerCase()).toBe("rn-view");
    const paragraphs = [...(root?.children ?? [])];
    expect(paragraphs.length).toBe(textBlocks(text).length);
    for (const paragraph of paragraphs) {
      expect(paragraph.tagName.toLowerCase()).toBe("rn-text");
      expect(paragraph.getAttribute("data-color")).toBe(darkTokens.foreground);
    }
    expect(
      paragraphs[0]?.querySelectorAll("[data-accessibility-role='link']").length,
    ).toBeGreaterThan(0);
  });

  it("sets user message text at 17pt on a 22pt line", () => {
    const user = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {"Plain message."}
      </LinkifiedText>,
    );
    expect(textStyle(user, "Plain message.")).toMatchObject({
      "data-font-size": "17",
      "data-line-height": "22",
    });
  });
});

describe("user message links", () => {
  it("opens a link tapped inside a user message bubble's long-press pressables", async () => {
    // The mobile thread wraps a user bubble in two long-press Pressables: the
    // row, then the bubble. A tap on the address still opens it, and markdown
    // markers stay literal characters.
    linking.openURL.mockClear();
    linking.canOpenURL.mockClear();
    const longPress = vi.fn();
    const view = await mount(
      <Pressable accessible={false} onLongPress={longPress}>
        <Pressable onLongPress={longPress}>
          <LinkifiedText
            color={darkTokens.foreground}
            linkColor={darkTokens.link}
            palette={darkTokens}
          >
            {"# Title **important** https://example.com/docs"}
          </LinkifiedText>
        </Pressable>
      </Pressable>,
    );

    const userLink = view.container.querySelector<HTMLElement>(
      "rn-pressable rn-pressable [data-accessibility-role='link']",
    );
    // A bare address shows as host and path, joined to its site icon.
    expect(userLink?.textContent).toBe("⁠⁨example.com/docs⁩");
    expect(view.container.textContent).toContain("# Title");
    expect(view.container.textContent).toContain("**important**");

    await act(async () => {
      userLink?.click();
    });
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      alert.mock.calls.at(-1)?.[2][1].onPress();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://example.com/docs");
    });
    expect(longPress).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("underlines a user-message link in the bubble's text colour", () => {
    const html = renderToStaticMarkup(
      <LinkifiedText
        color={darkTokens.chatUserForeground}
        linkColor={darkTokens.chatUserForeground}
        palette={darkTokens}
      >
        {"see https://example.com/docs"}
      </LinkifiedText>,
    );
    expect(html).toContain(
      `data-text-decoration-line="underline" data-text-decoration-color="${darkTokens.chatUserForeground}"`,
    );
    expect(html).not.toContain(`data-text-decoration-color="${darkTokens.input}"`);
  });

  it("draws the tile in user messages, in the message's own colour", async () => {
    const view = await mount(
      withFavicons(
        { load: async () => ({ icon: ICON }), globe },
        <LinkifiedText
          color={lightTokens.secondaryForeground}
          linkColor={lightTokens.link}
          palette={lightTokens}
        >
          {"look https://native-g.example.test/a/ or mail me@example.com"}
        </LinkifiedText>,
      ),
    );
    const [site, mail] = [
      ...view.container.querySelectorAll<HTMLElement>("rn-text[data-accessibility-role='link']"),
    ];
    expect(site?.getAttribute("data-accessibility-label")).toBe("native-g.example.test/a");
    expect(site?.getAttribute("data-color")).toBe(lightTokens.secondaryForeground);
    expect(site?.querySelector("rn-image")).not.toBeNull();
    expect(mail?.textContent).toBe("me@example.com");
    expect(mail?.querySelector("rn-view")).toBeNull();
    expect(mail?.getAttribute("data-color")).toBe(lightTokens.link);
    await view.cleanup();
  });
});

describe("user message direction", () => {
  const directionAttributes =
    /data-text-align|data-writing-direction|data-flex-direction="row-reverse"/;

  function userBubble(text: string) {
    const html = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {text}
      </LinkifiedText>,
    );
    return {
      html,
      root: new DOMParser().parseFromString(html, "text/html").querySelector("rn-text"),
    };
  }

  it("right-aligns a user message whose first letter is Hebrew or Arabic", () => {
    for (const text of [
      "שלום! זה מבחן של טקסט בעברית בלבד, עם סימני פיסוק בסוף.",
      "2026: مرحبا بالعالم، هذه رسالة طويلة بما يكفي لتلتف.",
      "«שלום», see the CHANGELOG sentence.",
    ]) {
      const { root } = userBubble(text);
      expect(root?.getAttribute("data-text-align")).toBe("right");
      // iOS already shapes each paragraph by its own first letter.
      expect(root?.hasAttribute("data-writing-direction")).toBe(false);
    }
  });

  it("leaves Latin, CJK and messages that start in English as they were", () => {
    for (const text of ["Hello there.", "你好，世界。", "Translate: שלום", "😀 123 !!", ""]) {
      expect(userBubble(text).html).not.toMatch(directionAttributes);
    }
  });

  it("aligns an English message to the far side in a right-to-left app", () => {
    i18n.isRTL = true;
    try {
      // React Native mirrors `right` in a right-to-left layout, so it lands on the left.
      expect(userBubble("Hello there.").root?.getAttribute("data-text-align")).toBe("right");
      expect(userBubble("שלום").html).not.toMatch(directionAttributes);
    } finally {
      i18n.isRTL = false;
    }
  });
});
