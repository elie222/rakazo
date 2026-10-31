// @vitest-environment jsdom

import { computerModelKey } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { rpc, capture } = vi.hoisted(() => ({
  rpc: vi.fn(),
  capture: vi.fn(async (spaceId: string) => ({ headers: { "x-rakazo-space-id": spaceId } })),
}));
vi.mock("./api", () => ({
  rpc,
  captureApiRequestContext: capture,
  currentApiBase: () => "https://fixture.invalid",
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (message: string) => message }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children: ReactNode; label: string }) =>
    createElement("section", null, label, children),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    choices,
    value,
    onChange,
    label,
  }: {
    choices: { key: string; label: string }[];
    value: string;
    onChange: (key: string) => void;
    label: string;
  }) =>
    createElement(
      "select",
      {
        value,
        "aria-label": label,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));

import { ComputerModelSettings } from "../components/computer-model-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
it.each(["account", "space", "bot"] as const)(
  "mobile saves explicit cross-provider identities in %s scope",
  async (scope) => {
    const target =
      scope === "bot"
        ? { kind: "bot" as const, botId: "bot" }
        : { kind: "connection" as const, credentialId: "claude-main", scope };
    const option = {
      mode: "model" as const,
      provider: "openai-codex",
      modelId: "gpt-4o",
      credentialId: "codex-target",
      label: "Vision",
      thinkingLevels: ["medium", "high"],
    };
    rpc.mockImplementation(async (_path, input) => ({
      selection: input.selection ?? null,
      options: [option],
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ComputerModelSettings, {
          target,
          userId: "user",
          spaceId: "space",
        }),
      ),
    );
    expect(host.textContent).toContain("Computer-use model");
    expect(host.textContent).toContain("Same as main model");
    expect(capture).toHaveBeenCalledWith("space");
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = computerModelKey(option);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rpc).toHaveBeenLastCalledWith(
      "models/setComputer",
      {
        expectedUserId: "user",
        target,
        selection: {
          mode: "model",
          provider: "openai-codex",
          modelId: "gpt-4o",
          credentialId: "codex-target",
          thinkingLevel: null,
        },
      },
      { requestContext: { headers: { "x-rakazo-space-id": "space" } } },
    );
    expect(host.querySelectorAll("select")).toHaveLength(1);
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("Default (Medium)");
    expect(host.querySelectorAll("select")).toHaveLength(2);
    await act(async () => root.unmount());
  },
);
