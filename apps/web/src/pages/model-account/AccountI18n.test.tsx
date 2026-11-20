// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AccountI18n } from "./AccountI18n";

vi.mock("./locales/de/messages.po?import", () => ({
  messages: { "Model account": "Modellkonto" },
}));
vi.mock("./locales/en/messages.po?import", () => ({
  messages: { "Model account": "Model account" },
}));
vi.mock("../../lib/locale/i18n", () => ({ i18n }));

it("switches feature translations without changing app catalogs or remounting pending work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load({ en: { Shared: "Shared" }, de: { Shared: "Geteilt" } });
  i18n.activate("en");
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function PendingWork() {
    const { i18n: scoped } = useLingui();
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return (
      <p>
        {scoped._("Model account")} {scoped._("Shared")}
      </p>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AccountI18n>
          <PendingWork />
        </AccountI18n>,
      ),
    );
    expect(host.textContent).toBe("Model account Shared");
    await act(async () => i18n.activate("de"));
    await act(async () => vi.dynamicImportSettled());
    expect(host.textContent).toBe("Modellkonto Geteilt");
    expect(i18n.messages).not.toHaveProperty("Model account");
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    i18n.activate("en");
    vi.unstubAllGlobals();
  }
});
