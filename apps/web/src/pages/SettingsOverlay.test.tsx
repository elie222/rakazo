// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
    i18n: { locale: "en" },
  }),
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
  OptionSelect: ({
    options,
    value,
    onValueChange,
    "data-testid": testId,
  }: {
    options: readonly { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
    "data-testid"?: string;
  }) => (
    <div>
      <button type="button" data-testid={testId}>
        {options.find((option) => option.value === value)?.label}
      </button>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: () => null,
  GeneralSettingsPanels: () => null,
  UpdatesSettingsPanel: () => null,
  UsageSettingsPanel: () => null,
}));
const { memoryConfigs, providerConfig, updaterStatus } = vi.hoisted(() => ({
  memoryConfigs: [] as unknown[],
  providerConfig: vi.fn(async (_spaceId: string): Promise<unknown> => null),
  updaterStatus: vi.fn(async (): Promise<unknown> => ({ installKind: "compose" })),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { updater: { status: updaterStatus } },
  rpcForSpace: (spaceId: string) => ({
    memory: { providerConfig: () => providerConfig(spaceId) },
  }),
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./MemorySettingsOverlay", () => ({
  MemorySettingsOverlay: ({ config }: { config: unknown }) => {
    memoryConfigs.push(config);
    return null;
  },
}));
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
  const rerender = async (next: Partial<React.ComponentProps<typeof SettingsOverlay>>) => {
    await act(async () => {
      root.render(
        <SettingsOverlay
          name="Jamie"
          onUsageOpen={() => undefined}
          timezone={null}
          onTimezoneChange={async () => undefined}
          memoryConfig={null}
          onMemoryConfigChange={() => undefined}
          onClose={() => undefined}
          section="general"
          onSectionChange={() => undefined}
          {...next}
        />,
      );
    });
  };
  await rerender(props);
  return {
    container,
    rerender,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("names the space a space-scoped section acts on and switches it in place", async () => {
  const onSpaceChange = vi.fn();
  const { container, cleanup } = await render({
    space: acme,
    spaces,
    onSpaceChange,
    section: "models",
  });
  try {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]');
    if (!trigger) throw new Error("Missing space switcher");
    expect(trigger.textContent).toBe("Acme");

    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Acme", "Beta"]);

    await act(async () => options[1]?.click());

    await vi.waitFor(() => expect(onSpaceChange).toHaveBeenCalledWith("space-b"));
  } finally {
    await cleanup();
  }
});

it("reports a section picked in the nav so the shell can keep it in the URL", async () => {
  const onSectionChange = vi.fn();
  const { container, cleanup } = await render({ onSectionChange });
  try {
    const usage = container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-usage"]');
    if (!usage) throw new Error("Missing Usage nav item");
    await act(async () => usage.click());
    expect(onSectionChange).toHaveBeenCalledWith("usage");
  } finally {
    await cleanup();
  }
});

it("opens a linked billing section once billing turns out to be on", async () => {
  const { container, rerender, cleanup } = await render({
    section: "billing",
    billingEnabled: false,
  });
  const shown = () =>
    container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section");
  try {
    expect(shown()).toBe("general");
    await rerender({ section: "billing", billingEnabled: true });
    expect(shown()).toBe("billing");
  } finally {
    await cleanup();
  }
});

it("shows the space name without a switcher when there is only one space", async () => {
  const { container, cleanup } = await render({
    space: acme,
    spaces: [acme],
    onSpaceChange: vi.fn(),
    section: "models",
  });
  try {
    const label = container.querySelector('[data-testid="settings-space"]');
    expect(label?.tagName).toBe("P");
    expect(label?.textContent).toBe("Acme");
  } finally {
    await cleanup();
  }
});

it("shows no space picker on sections that are not per space", async () => {
  const { container, cleanup } = await render({
    space: acme,
    spaces,
    onSpaceChange: vi.fn(),
    section: "general",
  });
  try {
    expect(container.querySelector('[data-testid="settings-space"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

it("never hands one space's memory config to another space's panel", async () => {
  const shared = { provider: "mem0", defaultMemoryScope: "shared" };
  providerConfig.mockImplementation(async (spaceId) => (spaceId === "space-b" ? shared : null));
  const gamma = { id: "space-c", name: "Gamma" };
  const props = {
    space: spaces[1],
    spaces: [...spaces, gamma],
    currentSpaceId: "space-a",
    onSpaceChange: vi.fn(),
    section: "memory" as const,
  };
  const { rerender, cleanup } = await render(props);
  try {
    await vi.waitFor(() => expect(memoryConfigs.at(-1)).toBe(shared));
    memoryConfigs.length = 0;
    // The parent answers onSpaceChange by passing the new space back in.
    await rerender({ ...props, space: gamma });
    await vi.waitFor(() => expect(memoryConfigs.at(-1)).toBeNull());
    expect(memoryConfigs).not.toContain(shared);
  } finally {
    await cleanup();
  }
});

it("withholds memory connection controls after a failed load and retries the edited space", async () => {
  memoryConfigs.length = 0;
  providerConfig.mockReset();
  providerConfig.mockRejectedValueOnce(new Error("Memory service unavailable"));
  let resolveRetry: (config: unknown) => void = () => undefined;
  providerConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
  );
  const onMemoryConfigChange = vi.fn();
  const { container, cleanup } = await render({
    space: spaces[1],
    currentSpaceId: "space-a",
    section: "memory",
    onMemoryConfigChange,
  });
  try {
    expect(container.textContent).toContain("Memory service unavailable");
    expect(memoryConfigs).not.toContain(null);
    const rendersBeforeRetry = memoryConfigs.length;
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(container.textContent).not.toContain("Memory service unavailable");
    expect(memoryConfigs.length).toBeGreaterThan(rendersBeforeRetry);
    expect(memoryConfigs.at(-1)).toBeUndefined();
    expect(providerConfig.mock.calls.map(([spaceId]) => spaceId)).toEqual(["space-b", "space-b"]);
    const config = { provider: "mem0", defaultMemoryScope: "shared" };
    await act(async () => resolveRetry(config));
    expect(memoryConfigs.at(-1)).toBe(config);
    expect(container.textContent).not.toContain("Retry");
    expect(onMemoryConfigChange).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

const updatesNav = (container: HTMLElement) =>
  container.querySelector('[data-testid="settings-nav-updates"]');

it("hides server updates and never requests server authority", async () => {
  const { container, cleanup } = await render({});
  try {
    expect(updatesNav(container)).toBeNull();
    expect(updaterStatus).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it("shows Updates in the desktop app", async () => {
  vi.stubGlobal("rakazoDesktop", { update: {} });
  const { container, cleanup } = await render({});
  try {
    expect(updatesNav(container)).not.toBeNull();
  } finally {
    await cleanup();
  }
});
