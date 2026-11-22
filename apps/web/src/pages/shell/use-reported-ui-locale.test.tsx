// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { installConsoleLogger } from "@rakazo/logging/console-logger";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateUiLocale, i18n, setCatalogLoadersForTests } from "../../lib/locale/i18n";
import { UI_LOCALES } from "../../lib/locale/ui-locale";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { useReportedUiLocale } from "./use-reported-ui-locale";

let container: HTMLDivElement;
let root: Root;
const update = vi.fn(async () => ({}));
const rpc = { preferences: { update } } as unknown as ReturnType<typeof createSpaceRpc>;

function Reporter({ saved }: { saved: string | null | undefined }) {
  useReportedUiLocale(rpc, saved);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installConsoleLogger("web");
  setCatalogLoadersForTests(
    Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
    ) as never,
  );
  await activateUiLocale("es");
  update.mockReset().mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCatalogLoadersForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves the app language when the account has another, then each one picked", async () => {
  act(() => root.render(<Reporter saved="en" />));
  expect(update).toHaveBeenCalledWith({ locale: "es" });

  await act(() => activateUiLocale("de"));
  expect(update).toHaveBeenLastCalledWith({ locale: "de" });
  expect(update).toHaveBeenCalledTimes(2);
});

it("leaves a matching account and an older server alone", async () => {
  act(() => root.render(<Reporter saved="es" />));
  act(() => root.render(<Reporter saved={undefined} />));
  await act(() => activateUiLocale("fr"));
  expect(update).not.toHaveBeenCalled();
});

it("logs a failed save and retries on a later report of the same language", async () => {
  update.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Reporter saved="en" />));
  expect(update).toHaveBeenCalledExactlyOnceWith({ locale: "es" });
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/best effort failed: save the reported UI locale.*error=Error: offline/),
  );

  await act(async () => i18n.activate("es"));
  expect(update.mock.calls).toEqual([[{ locale: "es" }], [{ locale: "es" }]]);
  expect(console.warn).toHaveBeenCalledTimes(1);
});

it("retries a cancelled save without logging a failure", async () => {
  update.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await act(async () => root.render(<Reporter saved="en" />));
  expect(update).toHaveBeenCalledExactlyOnceWith({ locale: "es" });
  expect(console.warn).not.toHaveBeenCalled();

  await act(async () => i18n.activate("es"));
  expect(update.mock.calls).toEqual([[{ locale: "es" }], [{ locale: "es" }]]);
  expect(console.warn).not.toHaveBeenCalled();
});

it("deduplicates the same language while pending and after success", async () => {
  const pending = deferred<object>();
  update.mockReturnValueOnce(pending.promise);
  await act(async () => root.render(<Reporter saved="en" />));
  await act(async () => i18n.activate("es"));
  expect(update).toHaveBeenCalledExactlyOnceWith({ locale: "es" });

  await act(async () => pending.resolve({}));
  await act(async () => i18n.activate("es"));
  expect(update).toHaveBeenCalledExactlyOnceWith({ locale: "es" });
});

it("does not let an older rejection invalidate a newer selection of the same language", async () => {
  const oldSpanish = deferred<object>();
  const latestSpanish = deferred<object>();
  update.mockReturnValueOnce(oldSpanish.promise).mockResolvedValueOnce({});
  update.mockReturnValueOnce(latestSpanish.promise);
  await act(async () => root.render(<Reporter saved="en" />));
  await act(() => activateUiLocale("de"));
  await act(() => activateUiLocale("es"));

  await act(async () => oldSpanish.reject(new Error("older request failed")));
  await act(async () => i18n.activate("es"));
  expect(update.mock.calls).toEqual([[{ locale: "es" }], [{ locale: "de" }], [{ locale: "es" }]]);

  await act(async () => latestSpanish.reject(new Error("newer request failed")));
  await act(async () => i18n.activate("es"));
  expect(update).toHaveBeenCalledTimes(4);
  expect(update).toHaveBeenLastCalledWith({ locale: "es" });
});

it("reports a return to the bootstrap language after a failed switch", async () => {
  await act(async () => root.render(<Reporter saved="en" />));
  update.mockRejectedValueOnce(new Error("offline"));
  await act(() => activateUiLocale("de"));

  await act(() => activateUiLocale("en"));
  expect(update.mock.calls).toEqual([[{ locale: "es" }], [{ locale: "de" }], [{ locale: "en" }]]);
});

it("ignores a queued language change after the reporter unmounts", async () => {
  await act(async () => root.render(<Reporter saved="en" />));
  act(() => {
    i18n.load("de", {});
    i18n.activate("de");
    root.render(null);
  });
  await act(async () => {});
  expect(update).toHaveBeenCalledExactlyOnceWith({ locale: "es" });
});
