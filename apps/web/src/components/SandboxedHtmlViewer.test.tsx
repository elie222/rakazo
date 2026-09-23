// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

async function render(html: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxedHtmlViewer title="Notes" html={html} />);
  });
  const iframe = container.querySelector("iframe");
  return {
    iframe,
    srcDoc: iframe?.getAttribute("srcdoc") ?? "",
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the preview iframe opaque and blocks remote images and fonts", async () => {
  const view = await render(
    '<img src="https://example.invalid/pixel.png"><style>@font-face { src: url(https://example.invalid/font.woff); }</style>',
  );

  expect(view.iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(view.iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(view.srcDoc).toContain("frame-src 'none'");
  expect(view.srcDoc).toContain("child-src 'none'");
  expect(view.srcDoc).toContain("img-src data:");
  expect(view.srcDoc).toContain("font-src data:");
  expect(view.srcDoc).not.toContain("allow-same-origin");
  expect(view.srcDoc).not.toMatch(/img-src[^;]*https:/);
  expect(view.srcDoc).not.toMatch(/font-src[^;]*https:/);
  expect(view.srcDoc).toContain("https://example.invalid/pixel.png");

  await view.cleanup();
});

it("embeds attacker markup so it cannot take over the navigation shell", async () => {
  const view = await render(
    '</script><script>location.href="https://example.invalid/nav"</script><iframe sandbox="allow-scripts allow-same-origin" src="https://example.invalid/frame"></iframe>',
  );

  const shell = view.srcDoc.split("srcdoc=")[0] ?? "";
  expect(shell).toContain('sandbox="allow-scripts"');
  expect(shell).not.toContain("allow-same-origin");
  expect(view.srcDoc).not.toContain("</script><script>");
  expect(view.srcDoc).toContain("\\u003c/script>");
  expect(view.srcDoc).toContain("frame-src 'none'");

  await view.cleanup();
});
