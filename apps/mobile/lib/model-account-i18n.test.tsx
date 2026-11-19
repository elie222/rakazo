// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { activateUiLocale } from "./i18n/i18n";
import { useI18n } from "./model-account-i18n";

it("keeps translation callbacks stable until the locale changes and preserves shared messages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activateUiLocale("en");
  const callbacks: unknown[] = [];
  function Account() {
    const { t } = useI18n();
    callbacks.push(t);
    return (
      <p>
        {t("Model account")} {t("Move up")}
      </p>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Account />));
    await act(async () => root.render(<Account />));
    expect(callbacks[0]).toBe(callbacks[1]);
    await act(async () => activateUiLocale("zh-CN"));
    expect(host.textContent).toContain("模型账户");
    expect(host.textContent).not.toContain("Move up");
    expect(callbacks.at(-1)).not.toBe(callbacks[0]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    activateUiLocale("en");
    vi.unstubAllGlobals();
  }
});
