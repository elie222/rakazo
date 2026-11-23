// @vitest-environment jsdom
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const webview = vi.hoisted(() => ({
  props: undefined as undefined | { onRenderProcessGone?: () => void },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: { onRenderProcessGone?: () => void }) => {
    webview.props = props;
    return createElement("rn-webview");
  },
}));
vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://api.example.test",
  subscribeApiBase: () => () => {},
}));

import { MermaidDiagram } from "./mermaid-diagram";

it("falls back to the code block when the diagram's renderer process dies", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MermaidDiagram
        source={"flowchart TD\n  A --> B\n  B --> C"}
        palette={lightTokens}
        colorScheme="light"
        fallback={<pre>code block</pre>}
      />,
    ),
  );
  expect(container.querySelector("rn-webview")).not.toBeNull();

  await act(async () => webview.props?.onRenderProcessGone?.());

  expect(container.querySelector("rn-webview")).toBeNull();
  expect(container.textContent).toBe("code block");
  await act(async () => root.unmount());
});
