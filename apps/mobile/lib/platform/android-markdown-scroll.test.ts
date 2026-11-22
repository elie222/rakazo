import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const segments = join(
  dirname(require.resolve("react-native-enriched-markdown/package.json")),
  "android/src/main/java/com/swmansion/enriched/markdown/segments",
);

function readSegment(name: string) {
  return readFileSync(join(segments, `${name}.kt`), "utf8");
}

describe("Android Markdown horizontal scrolling", () => {
  it.each(["CodeBlockContainerView", "TableContainerView"])(
    "%s uses the direction-aware native scroller",
    (container) => {
      expect(readSegment(container)).toContain("MarkdownHorizontalScrollView(context)");
    },
  );

  it("holds off parent interception only for overflowing blocks and yields vertical drags", () => {
    const source = readSegment("MarkdownHorizontalScrollView");
    expect(source).toMatch(
      /ACTION_DOWN -> \{[^}]*canScrollHorizontally\(-1\) \|\| canScrollHorizontally\(1\)[^}]*if \(scrollable\) parent\?\.requestDisallowInterceptTouchEvent\(true\)/,
    );
    expect(source).toContain("if (max(dx, dy) > touchSlop)");
    expect(source).toContain("if (dx >= dy) Drag.Horizontal else Drag.Vertical");
    expect(source).toContain(
      "if (drag == Drag.Vertical) parent?.requestDisallowInterceptTouchEvent(false)",
    );
    expect(source).toContain(
      "MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL",
    );
  });

  it("starts at the physical left and does not reapply a table offset during layout", () => {
    expect(readSegment("MarkdownHorizontalScrollView")).toContain(
      "layoutDirection = View.LAYOUT_DIRECTION_LTR",
    );
    expect(readSegment("TableContainerView")).not.toContain("scrollView.scrollTo(");
  });
});
