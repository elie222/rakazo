// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PageLoading } from "./PageLoading";

vi.mock("@rakazo/ui-web", async () => {
  const { Spinner } = await import("@rakazo/ui-web/components/ui/spinner");
  return { Spinner };
});

it("stops the spinner rotating when reduced motion is requested", () => {
  i18n.load("en", {});
  i18n.activate("en");
  const markup = renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <PageLoading />
    </I18nProvider>,
  );
  const spinner = new DOMParser()
    .parseFromString(markup, "text/html")
    .querySelector('svg[role="status"]');
  expect(spinner?.getAttribute("aria-label")).toBe("Loading…");
  expect(spinner?.classList.contains("motion-reduce:animate-none")).toBe(true);
});
