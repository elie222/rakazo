// @vitest-environment jsdom
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

type WebViewProps = {
  dataDetectorTypes?: unknown;
  containerStyle?: unknown;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
};

const webview = vi.hoisted(() => ({ props: undefined as undefined | WebViewProps }));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown): unknown =>
      Array.isArray(style) ? Object.assign({}, ...style.map((part) => part ?? {})) : style,
    hairlineWidth: 1,
  },
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: WebViewProps) => {
    webview.props = props;
    return createElement("rn-webview");
  },
}));
vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://api.example.test",
  subscribeApiBase: () => () => {},
}));

import { StyleSheet } from "react-native";
import { MermaidDiagram } from "./mermaid-diagram";

async function renderDiagram() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <MermaidDiagram
        source={"flowchart TD\n  A --> B\n  B --> C"}
        palette={lightTokens}
        colorScheme="light"
        fallback={null}
      />,
    ),
  );
  return root;
}

// Android's native WebView reads the prop as a list without converting it, and a plain string
// crashes the app as the WebView is created; only the iOS wrapper accepts a string.
it("gives the WebView its data detector types as a list", async () => {
  const root = await renderDiagram();

  expect(webview.props?.dataDetectorTypes).toEqual(["none"]);
  await act(async () => root.unmount());
});

// The WebView's own container is `flex: 1` with no height, which a chat bubble laid out at an exact
// size (Android's markdown slots) squeezes to nothing, leaving an empty card.
it("gives the drawn diagram's WebView container the diagram's height", async () => {
  const root = await renderDiagram();
  await act(async () =>
    webview.props?.onMessage?.({
      nativeEvent: { data: JSON.stringify({ type: "drawn", height: 240 }) },
    }),
  );

  expect(StyleSheet.flatten(webview.props?.containerStyle as never)).toMatchObject({
    flex: 0,
    height: 240,
  });
  await act(async () => root.unmount());
});
