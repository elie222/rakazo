// @vitest-environment jsdom

import type { Messages } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { messages as de } from "../locales/de/messages.po";
import { messages as en } from "../locales/en/messages.po";
import { MarkdownChrome } from "./markdown-copy";

it("translates markdown controls with real catalogs and updates them when the locale changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const i18n = setupI18n({ locale: "de", messages: { de: de as Messages, en: en as Messages } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const markdown = [
    "```js\nconst value = 1;\n```",
    `| | Name | Name |\n| --- | --- | --- |\n${Array.from(
      { length: 11 },
      (_, i) => `| ${i} | A | B |`,
    ).join("\n")}`,
    "| Item |\n| --- |\n| A |\n| B |",
  ].join("\n\n");
  try {
    await act(async () => {
      root.render(
        <I18nProvider i18n={i18n}>
          <MarkdownChrome>
            <ChatMarkdown>{markdown}</ChatMarkdown>
          </MarkdownChrome>
        </I18nProvider>,
      );
    });
    expect(container.querySelector('[aria-label="Code kopieren"]')).not.toBeNull();
    expect(container.textContent).toContain("1–10 von 11 Zeilen");
    expect(container.textContent).toContain("2 Zeilen");
    expect(container.querySelector('[aria-label="Nach Spalte 1 sortieren"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Nach Name, Spalte 2 sortieren"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Nach Name, Spalte 2 sortieren"]')
        ?.click();
    });
    expect(container.textContent).toContain("Nach Name, Spalte 2 sortiert, aufsteigend");

    await act(async () => i18n.activate("en"));

    expect(container.querySelector('[aria-label="Copy code"]')).not.toBeNull();
    expect(container.textContent).toContain("1–10 of 11 rows");
    expect(container.textContent).toContain("2 rows");
    expect(container.querySelector('[aria-label="Sort by column 1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Sort by Name, column 2"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Code kopieren"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
