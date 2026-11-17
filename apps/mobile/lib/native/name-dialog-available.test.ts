import { afterEach, expect, it, vi } from "vitest";

const views = [
  "HostView",
  "AlertDialogView",
  "SlotView",
  "TextFieldView",
  "TextButton",
  "TextView",
];
afterEach(() => vi.unstubAllGlobals());

it.each([null, ...views])(
  "uses Compose only with all dialog views (missing %s)",
  async (missing) => {
    vi.resetModules();
    vi.stubGlobal("expo", {
      getViewConfig: (_module: string, view: string) => (view === missing ? null : {}),
    });
    const { isNameDialogAvailable } = await import("./name-dialog-available");
    expect(isNameDialogAvailable()).toBe(missing === null);
  },
);

it("falls back when the native lookup is unavailable", async () => {
  vi.resetModules();
  vi.stubGlobal("expo", undefined);
  const { isNameDialogAvailable } = await import("./name-dialog-available");
  expect(isNameDialogAvailable()).toBe(false);
});
