// @vitest-environment jsdom
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const webview = vi.hoisted(() => ({
  props: undefined as undefined | { dataDetectorTypes?: unknown },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: { dataDetectorTypes?: unknown }) => {
    webview.props = props;
    return createElement("rn-webview");
  },
}));
vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://api.example.test",
  subscribeApiBase: () => () => {},
}));

import { MermaidDiagram } from "./mermaid-diagram";

// Android's native WebView reads the prop as a list without converting it, and a plain string
// crashes the app as the WebView is created; only the iOS wrapper accepts a string.
it("gives the WebView its data detector types as a list", async () => {
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

  expect(webview.props?.dataDetectorTypes).toEqual(["none"]);
  await act(async () => root.unmount());
});
