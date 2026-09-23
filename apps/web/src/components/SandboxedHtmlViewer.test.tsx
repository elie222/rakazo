// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

it("keeps the preview iframe opaque and blocks remote images and fonts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SandboxedHtmlViewer
        title="Notes"
        html={
          '<img src="https://example.invalid/pixel.png"><style>@font-face { src: url(https://example.invalid/font.woff); }</style>'
        }
      />,
    );
  });

  const iframe = container.querySelector("iframe");
  const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
  const policy = /^<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(srcDoc)?.[1];
  expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(policy).toContain("img-src data:");
  expect(policy).toContain("font-src data:");
  expect(policy).not.toMatch(/img-src[^;]*https:/);
  expect(policy).not.toMatch(/font-src[^;]*https:/);
  expect(srcDoc).toContain("https://example.invalid/pixel.png");

  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
