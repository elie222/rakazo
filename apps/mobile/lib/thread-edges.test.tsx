import { readFileSync } from "node:fs";
import { createElement } from "react";
import { Platform } from "react-native";
import { ScrollViewMarker } from "react-native-screens/experimental";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadScrollSurface } from "../components/thread-scroll-surface";
import {
  THREAD_HEADER_FADE_GRADIENT,
  threadEdgeOptions,
  threadHeaderClearance,
  threadHeaderFloats,
  threadScrollEdgeEffects,
} from "./thread-edges";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: 26 } }));
vi.mock("react-native-screens/experimental", () => ({ ScrollViewMarker: () => null }));

afterEach(() => {
  Platform.OS = "ios";
  Platform.Version = 26;
});

describe("thread scroll edges", () => {
  it("hides all four edges while keeping the iOS 26 header transparent", () => {
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      scrollEdgeEffects: { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" },
    });
    const child = createElement("scroll-view");
    const surface = ThreadScrollSurface({ children: child });
    expect(surface.type).toBe(ScrollViewMarker);
    expect(surface.props).toEqual({
      style: { flex: 1 },
      scrollEdgeEffects: threadScrollEdgeEffects,
      children: child,
    });
  });

  it.each(["18.5", 25, 26, "26.1"])("floats the header on iOS %s", (version) => {
    Platform.Version = version;
    expect(threadHeaderFloats()).toBe(true);
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      scrollEdgeEffects: threadScrollEdgeEffects,
    });
    const child = createElement("scroll-view");
    if (Number.parseFloat(String(version)) < 26) {
      expect(ThreadScrollSurface({ children: child })).toBe(child);
    }
  });

  it("preserves the Android tree and header", () => {
    Platform.OS = "android";
    const child = createElement("scroll-view");
    expect(ThreadScrollSurface({ children: child })).toBe(child);
    expect(threadHeaderFloats()).toBe(false);
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: false,
      scrollEdgeEffects: threadScrollEdgeEffects,
    });
  });

  it("uses the floating header height for message clearance and the fade", () => {
    const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
    expect(source).toContain("const headerHeight = threadHeaderFloats() ? nativeHeaderHeight : 0;");
    expect(source).toContain("paddingBottom: headerClearance.padding");
    expect(source).toContain("paddingTop: headerClearance.padding");
    expect(source).toContain("paddingTop: readOnly ? insets.bottom + 16 : 16");
    expect(source).toContain("minHeight: headerClearance.minHeight");
    expect(source).toContain("jumpAnchor.current.align(headerClearance.anchor)");
    expect(source).toContain("styles.headerFade, { height: headerClearance.opaqueHeight }");
    expect(source).toContain("<View style={styles.headerFadeEdge} />");
    expect(source).toContain(
      "headerAdjacent={threadHeaderFloats() && message.id === visibleMessages[0]?.id}",
    );
    expect(source).toContain("marginTop: headerAdjacent ? 0 : 12");
  });

  it("remounts each marker with its live or pinned scroll view", () => {
    const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
    const file = ts.createSourceFile(
      "thread.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const keys: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(file) === "ThreadScrollSurface"
      ) {
        const key = node.openingElement.attributes.properties.find(
          (prop) => ts.isJsxAttribute(prop) && prop.name.getText(file) === "key",
        );
        if (key) keys.push(key.getText(file));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(keys).toEqual([
      `key={\`pinned:\${jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}\`}`,
      `key={\`live:\${threadKey}\`}`,
    ]);
  });
});

it.each([64, 96, 116, 120])(
  "places the band and jump targets below the pills at header height %s",
  (height) => {
    const clearance = threadHeaderClearance(height);
    const pillBottom = height - 10;
    expect(clearance.opaqueHeight - pillBottom).toBe(14);
    expect(THREAD_HEADER_FADE_GRADIENT).toBe(12);
    expect(clearance.padding).toBe(clearance.opaqueHeight);
    expect(clearance.minHeight).toBeGreaterThanOrEqual(clearance.opaqueHeight);
    expect(clearance.anchor).toBeGreaterThan(clearance.opaqueHeight + THREAD_HEADER_FADE_GRADIENT);
    // The first date has a 12pt margin and about 4pt of font leading.
    expect(clearance.padding + 16 - pillBottom).toBe(30);
  },
);

it("preserves Android clearance without a floating header", () => {
  expect(threadHeaderClearance(0)).toEqual({
    opaqueHeight: 0,
    padding: 8,
    anchor: 24,
    minHeight: 0,
  });
});
