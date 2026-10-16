// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    initialFocus: _initialFocus,
    ...props
  }: { children?: ReactNode; showCloseButton?: boolean; initialFocus?: unknown } & Omit<
    React.ComponentProps<"div">,
    "children"
  >) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  NativeSelect: ({ children, ...props }: React.ComponentProps<"select">) => (
    <select {...props}>{children}</select>
  ),
  NativeSelectOption: ({ children, ...props }: React.ComponentProps<"option">) => (
    <option {...props}>{children}</option>
  ),
}));

vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: () => null,
  GeneralSettingsPanels: () => null,
  UpdatesSettingsPanel: () => null,
  UsageSettingsPanel: () => null,
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./MemorySettingsOverlay", () => ({ MemorySettingsOverlay: () => null }));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => null }));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));

import { SettingsOverlay } from "./SettingsOverlay";

const acme = { id: "space-a", name: "Acme" };
const spaces = [acme, { id: "space-b", name: "Beta" }];

async function render(props: Partial<React.ComponentProps<typeof SettingsOverlay>>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SettingsOverlay
        name="Jamie"
        onUsageOpen={() => undefined}
        avatarStyle="robot"
        onAvatarStyleChange={async () => undefined}
        memoryConfig={null}
        onMemoryConfigChange={() => undefined}
        onClose={() => undefined}
        {...props}
      />,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("names the space the settings act on and switches it, keeping the section", async () => {
  const onSpaceChange = vi.fn();
  const { container, cleanup } = await render({
    space: acme,
    spaces,
    onSpaceChange,
    initialSection: "models",
  });
  try {
    const select = container.querySelector<HTMLSelectElement>('[data-testid="settings-space"]');
    if (!select) throw new Error("Missing space switcher");
    expect(select.value).toBe("space-a");
    expect([...select.options].map((option) => option.textContent)).toEqual(["Acme", "Beta"]);

    await act(async () => {
      select.value = "space-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await vi.waitFor(() => expect(onSpaceChange).toHaveBeenCalledWith("space-b", "models"));
  } finally {
    await cleanup();
  }
});

it("shows the space name without a switcher when there is only one space", async () => {
  const { container, cleanup } = await render({
    space: acme,
    spaces: [acme],
    onSpaceChange: vi.fn(),
  });
  try {
    const label = container.querySelector('[data-testid="settings-space"]');
    expect(label?.tagName).toBe("P");
    expect(label?.textContent).toBe("Acme");
  } finally {
    await cleanup();
  }
});
