import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactNative from "react-native";
import type { TextInputProps, TextProps } from "react-native";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { capTextScaling, stacksAtTextScale } from "./text-scale";

// iOS font scales: xSmall … xxLarge, then xxxLarge and the five accessibility sizes.
describe("stacksAtTextScale", () => {
  it("keeps content side by side up to the xxLarge text size", () => {
    for (const fontScale of [0.823, 0.882, 0.941, 1, 1.118, 1.235]) {
      expect(stacksAtTextScale(fontScale)).toBe(false);
    }
  });

  it("stacks from the xxxLarge text size, where text reaches its cap, through the accessibility sizes", () => {
    expect(stacksAtTextScale(MAX_FONT_SCALE)).toBe(true);
    for (const fontScale of [1.353, 1.786, 2.143, 2.643, 3.143, 3.571]) {
      expect(stacksAtTextScale(fontScale)).toBe(true);
    }
  });
});

// A stand-in for the react-native module, which exposes its components through getters.
function fakeReactNative() {
  const Text = (_props: TextProps) => null;
  const TextInput = Object.assign((_props: TextInputProps) => null, {
    State: { currentlyFocusedInput: () => null },
  });
  const reactNative = {
    get Text() {
      return Text;
    },
    get TextInput() {
      return TextInput;
    },
  } as unknown as typeof ReactNative;
  return { reactNative, Text, TextInput };
}

function rendered(component: unknown, props: object) {
  return (component as (props: object) => ReactElement<Record<string, unknown>>)(props);
}

describe("capTextScaling", () => {
  it("stops body text at 23pt", () => {
    expect(17 * MAX_FONT_SCALE).toBe(23);
  });

  it("caps every Text and TextInput unless it sets its own limit", () => {
    const { reactNative, Text, TextInput } = fakeReactNative();
    capTextScaling(reactNative);

    const text = rendered(reactNative.Text, { children: "Hello" });
    expect(text.type).toBe(Text);
    expect(text.props).toEqual({ children: "Hello", maxFontSizeMultiplier: MAX_FONT_SCALE });

    const input = rendered(reactNative.TextInput, { placeholder: "Message" });
    expect(input.type).toBe(TextInput);
    expect(input.props.maxFontSizeMultiplier).toBe(MAX_FONT_SCALE);

    expect(rendered(reactNative.Text, { maxFontSizeMultiplier: 1.2 }).props).toEqual({
      maxFontSizeMultiplier: 1.2,
    });
  });

  it("keeps refs and TextInput's statics, and caps only once", () => {
    const { reactNative, Text, TextInput } = fakeReactNative();
    capTextScaling(reactNative);
    const cappedText = reactNative.Text;
    capTextScaling(reactNative);

    expect(reactNative.Text).toBe(cappedText);
    expect(rendered(reactNative.Text, {}).type).toBe(Text);
    expect(reactNative.TextInput.State).toBe(TextInput.State);
    const ref = { current: null };
    expect(rendered(reactNative.TextInput, { ref }).props.ref).toBe(ref);
  });

  it("caps only once when Fast Refresh runs this file again", async () => {
    const { reactNative, Text } = fakeReactNative();
    capTextScaling(reactNative);
    const cappedText = reactNative.Text;
    vi.resetModules();
    const reloaded = await import("./text-scale");
    reloaded.capTextScaling(reactNative);

    expect(reactNative.Text).toBe(cappedText);
    expect(rendered(reactNative.Text, {}).type).toBe(Text);
  });
});

// React Native's real entry module, with its components stubbed to show the limit they receive.
function reactNativeEntry() {
  const entry = createRequire(import.meta.url).resolve("react-native");
  // The entry is Flow; dropping its one type-only import leaves syntax TypeScript can strip.
  const source = readFileSync(entry, "utf8").replace(/^import typeof .*$/m, "");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const native =
    (tag: string) =>
    ({
      children,
      maxFontSizeMultiplier,
    }: {
      children?: ReactNode;
      maxFontSizeMultiplier?: number;
    }) =>
      createElement(tag, { "data-max-font-size-multiplier": maxFontSizeMultiplier }, children);
  const components: Record<string, unknown> = {
    "./Libraries/Text/Text": native("rn-text"),
    "./Libraries/Components/TextInput/TextInput": native("rn-text-input"),
  };
  const module = { exports: {} as typeof ReactNative };
  const require = (path: string) => ({ default: components[path] });
  new Function("module", "exports", "require", "__DEV__", outputText)(
    module,
    module.exports,
    require,
    false,
  );
  return module.exports;
}

describe("capTextScaling on React Native's own module", () => {
  it("replaces Text and TextInput, which the module exposes as configurable getters", () => {
    const reactNative = reactNativeEntry();
    for (const name of ["Text", "TextInput"]) {
      const descriptor = Object.getOwnPropertyDescriptor(reactNative, name);
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.configurable).toBe(true);
    }

    capTextScaling(reactNative);

    // A component imported from react-native reads it from the module when it renders.
    const text = renderToStaticMarkup(createElement(reactNative.Text, null, "Hello"));
    expect(text).toBe(`<rn-text data-max-font-size-multiplier="${MAX_FONT_SCALE}">Hello</rn-text>`);
    const input = renderToStaticMarkup(createElement(reactNative.TextInput));
    expect(input).toContain(`data-max-font-size-multiplier="${MAX_FONT_SCALE}"`);
    const own = renderToStaticMarkup(
      createElement(reactNative.Text, { maxFontSizeMultiplier: 1.2 }, "Title"),
    );
    expect(own).toContain('data-max-font-size-multiplier="1.2"');
  });
});
