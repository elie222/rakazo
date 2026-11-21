// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PageLoading } from "./PageLoading";

vi.mock("@rakazo/ui-web", async () => {
  const { Spinner } = await import("@rakazo/ui-web/components/ui/spinner");
  return { Spinner };
});

function renderSpinner() {
  const markup = renderToStaticMarkup(<PageLoading />);
  return new DOMParser().parseFromString(markup, "text/html").querySelector('svg[role="status"]');
}

it("keeps the visible spinner and its route loading announcement", () => {
  const spinner = renderSpinner();
  expect(spinner?.getAttribute("aria-label")).toBe("Loading…");
  expect(spinner?.classList.contains("size-5")).toBe(true);
  expect(spinner?.parentElement?.classList.contains("delay-500")).toBe(true);
  expect(spinner?.parentElement?.classList.contains("motion-reduce:animate-none")).toBe(true);
});

it("disables the spinner's own animation only for reduced motion", () => {
  const spinner = renderSpinner();
  expect(spinner?.classList.contains("animate-spin")).toBe(true);
  expect(spinner?.classList.contains("motion-reduce:animate-none")).toBe(true);
});
