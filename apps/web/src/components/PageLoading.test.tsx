// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PageLoading } from "./PageLoading";
import { RouteLoading } from "./RouteLoading";

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

describe("PageLoading", () => {
  it("waits half a second by default", () => {
    const { host, root } = render(<PageLoading />);
    expect(
      host
        .querySelector<HTMLElement>(".page-loading-fade")
        ?.style.getPropertyValue("--page-loading-delay"),
    ).toBe("500ms");
    act(() => root.unmount());
  });

  it("lets a route wait only 120ms before showing the spinner", () => {
    const { host, root } = render(<RouteLoading />);
    expect(
      host
        .querySelector<HTMLElement>(".page-loading-fade")
        ?.style.getPropertyValue("--page-loading-delay"),
    ).toBe("120ms");
    act(() => root.unmount());
  });
});
