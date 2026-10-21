import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const avoidingView = source.slice(
  source.indexOf("<KeyboardAvoidingView"),
  source.indexOf("style={{", source.indexOf("<KeyboardAvoidingView")),
);

describe("thread keyboard avoidance", () => {
  it("measures a native flex wrapper rather than the avoiding view class instance", () => {
    expect(source).toMatch(
      /<View\s+ref={keyboardLayout.container}\s+onLayout={keyboardLayout.onLayout}\s+style={{ flex: 1 }}\s*>\s*<KeyboardAvoidingView/,
    );
    expect(avoidingView).not.toContain("ref={keyboardLayout.container}");
    expect(avoidingView).not.toContain("onLayout={keyboardLayout.onLayout}");
    expect(avoidingView).toContain("keyboardVerticalOffset={keyboardLayout.offset}");
  });

  // A keyboard opened on a pushed screen hides without move frames when that screen closes.
  // The "height" behavior then keeps the chat shrunk with an empty gap under the composer.
  it("uses padding, which settles to zero when the keyboard hides", () => {
    expect(avoidingView).toContain('behavior="padding"');
    expect(avoidingView).not.toContain('behavior="height"');
  });
});
