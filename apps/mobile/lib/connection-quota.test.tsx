// @vitest-environment jsdom

import type { ModelQuota } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionQuota } from "../components/connection-quota";

vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, value }: { title: string; value?: string }) => (
    <div>
      {title} {value}
    </div>
  ),
}));
vi.mock("./i18n", () => ({
  useUiLocale: () => "de",
  dateLocaleForUi: () => "de-DE",
}));

afterEach(() => vi.unstubAllGlobals());

async function render(quota: Partial<ModelQuota>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConnectionQuota
        quota={{
          credentialId: "connection",
          status: "fresh",
          observedAt: null,
          checkedAt: "2030-01-01T00:00:00.000Z",
          windows: [],
          ...quota,
        }}
        loading={false}
        onRefresh={() => undefined}
      />,
    );
  });
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

it("has no rows for a connection with no quota to read", async () => {
  expect(await render({ status: "unsupported" })).toBe("");
});

it("offers Refresh when a reading failed", async () => {
  const text = await render({ status: "unavailable" });
  expect(text).toContain("Quota unavailable");
  expect(text).toContain("Refresh");
});

it("formats the remaining percentage in the app language", async () => {
  const text = await render({
    windows: [{ id: "seven_day", usedPercent: 54.5, resetsAt: null, modelIds: null }],
  });
  expect(text).toContain("45,5% remaining");
});
