import { readFileSync } from "node:fs";
import { createElement } from "react";
import { Platform } from "react-native";
import { ScrollViewMarker } from "react-native-screens/experimental";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadScrollSurface } from "../components/thread-scroll-surface";
import { threadEdgeOptions, threadScrollEdgeEffects } from "./thread-edges";

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

  it.each(["android", "older-ios"])("preserves the %s tree and header", (platform) => {
    if (platform === "android") Platform.OS = "android";
    else Platform.Version = 25;
    const child = createElement("scroll-view");
    expect(ThreadScrollSurface({ children: child })).toBe(child);
    expect(threadEdgeOptions().headerTransparent).toBe(false);
    expect(threadEdgeOptions()).not.toHaveProperty("headerStyle");
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
