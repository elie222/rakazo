// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  buttonVariants: (await importOriginal<typeof UiWeb>()).buttonVariants,
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: React.ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: React.ComponentProps<"option">) => <option {...props} />,
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    children,
    onPressedChange,
    pressed: _pressed,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    onPressedChange?: () => void;
    pressed?: boolean;
    variant?: string;
  } & React.ComponentProps<"button">) => (
    <button type="button" onClick={() => onPressedChange?.()} {...props}>
      {children}
    </button>
  ),
  ToggleGroup: (await importOriginal<typeof UiWeb>()).ToggleGroup,
  ToggleGroupItem: (await importOriginal<typeof UiWeb>()).ToggleGroupItem,
  OptionSelect: ({ "data-testid": testId }: { "data-testid"?: string }) => (
    <div data-testid={testId} />
  ),
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

const breakdownCalls = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/query")>()),
  useSpaceQueries: () => ({
    usage: {
      breakdown: {
        queryOptions: ({ input }: { input: unknown }) => ({
          queryKey: ["usage-breakdown", input],
          queryFn: () => breakdownCalls.fetch(input),
        }),
      },
    },
  }),
}));

vi.mock("../lib/auth-capabilities", () => ({
  fetchAuthCapabilities: vi.fn(async () => ({
    providers: [{ id: "social-one", name: "Provider" }],
  })),
}));
vi.mock("../lib/passkeys", () => ({
  usePasskeysSupported: () => false,
  usePasskeysVersion: () => 0,
}));
const accountPolicy = vi.hoisted(() => ({
  hasPassword: true,
  linkedProviderIds: undefined as string[] | undefined,
  passwordChangeEnabled: undefined as boolean | undefined,
}));
vi.mock("../components/AccountAccess", () => ({
  LinkSsoRow: ({ provider }: { provider: { name: string } }) => (
    <button type="button">Link {provider.name}</button>
  ),
  AccountAccess: ({ onSecurity }: { onSecurity: (value: AccountSecurity) => void }) => {
    useEffect(
      () =>
        onSecurity({
          hasPassword: accountPolicy.hasPassword,
          linkedProviderIds: accountPolicy.linkedProviderIds,
          passwordChangeEnabled: accountPolicy.passwordChangeEnabled,
          freshOidcAuth: false,
          ssoLinked: false,
          emailDeletion: false,
          sso: null,
        }),
      [onSecurity],
    );
    return null;
  },
}));

vi.mock("../components/AccountDataSettings", () => ({ AccountDataSettings: () => null }));
vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("../components/TrustedLinkSitesSettings", () => ({
  TrustedLinkSitesSettings: () => null,
}));
vi.mock("../components/ai/primitives", () => ({ SuccessPop: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("../components/ComputerDeviceSettings", () => ({ ComputerDeviceSettings: () => null }));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: vi.fn(), updateUser: vi.fn() } }));
vi.mock("../lib/i18n", () => ({
  getActiveUiLocale: () => "en",
  setUiLocale: (locale: string) => Promise.resolve(locale),
}));
vi.mock("../lib/ui-appearance", () => ({
  getUiAppearancePreference: () => "system",
  setUiAppearance: vi.fn(),
}));

import { authClient } from "../lib/auth";
import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  composerEnterToSendPreference,
} from "../lib/composer-enter-to-send-pref";
import { localTimezone } from "../lib/local-timezone";
import { remoteImagesPreference } from "../lib/remote-images-preference";
import { TOOL_ACTIVITY_STORAGE_KEY } from "../lib/tool-activity-preference";
import { GeneralSettingsPanels } from "./AccountSettingsOverlay";
import { UsageSettingsPanel } from "./UsageSettingsPanel";

afterEach(() => {
  localStorage.clear();
});

it.each([undefined, null, "device", "different"])(
  "only offers the device timezone when the selected timezone differs (%s)",
  async (saved) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const deviceTimezone = localTimezone();
    const timezone =
      saved === "device"
        ? deviceTimezone
        : saved === "different"
          ? deviceTimezone === "UTC"
            ? "Europe/London"
            : "UTC"
          : saved;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <GeneralSettingsPanels
            name="Test"
            timezone={timezone}
            onTimezoneChange={async () => {}}
          />,
        ),
      );
      expect(
        container.querySelector<HTMLSelectElement>('[data-testid="timezone-select"]')?.value,
      ).toBe(timezone ?? deviceTimezone);
      expect(Boolean(container.querySelector('[data-testid="timezone-use-device"]'))).toBe(
        saved === "different",
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("flips the stored tool activity preference from the settings toggle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<GeneralSettingsPanels name="Jamie" />);
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-activity-toggle"]',
    );
    if (!toggle) throw new Error("Missing tool activity toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("on");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("turns loading web images on and off from the settings toggle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<GeneralSettingsPanels name="Jamie" />);
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-images-toggle"]',
    );
    if (!toggle) throw new Error("Missing remote images toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(remoteImagesPreference.get()).toBe(false);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(remoteImagesPreference.get()).toBe(true);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(remoteImagesPreference.get()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([undefined, true, false])("respects the password-change policy (%s)", async (enabled) => {
  accountPolicy.passwordChangeEnabled = enabled;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GeneralSettingsPanels name="Test" />));
    expect(container.textContent?.includes("Change password")).toBe(enabled !== false);
  } finally {
    await act(async () => root.unmount());
    accountPolicy.passwordChangeEnabled = undefined;
    vi.unstubAllGlobals();
  }
});

it("keeps the password form closed until asked and closes it after a change", async () => {
  vi.mocked(authClient.changePassword).mockResolvedValue({ data: {}, error: null } as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const passwordFields = () => container.querySelectorAll('input[type="password"]');
  const setValue = (input: Element, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () => root.render(<GeneralSettingsPanels name="Test" />));
    expect(passwordFields()).toHaveLength(0);

    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change password",
    );
    await act(async () => open?.click());
    const [current, next, confirm] = passwordFields();
    await act(async () => {
      setValue(current!, "old-password");
      setValue(next!, "new-password-123");
      setValue(confirm!, "new-password-123");
    });
    await act(async () => container.querySelector("form")?.requestSubmit());

    expect(authClient.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "new-password-123",
      revokeOtherSessions: true,
    });
    expect(passwordFields()).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("updates the Enter preference from Settings and reflects external changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  composerEnterToSendPreference.set(true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<GeneralSettingsPanels name="Test" />);
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-enter-to-send-toggle"]',
    );
    if (!toggle) throw new Error("Missing Enter preference");
    expect(container.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe(
      "Send with Enter",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(composerEnterToSendPreference.get()).toBe(false);
    expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("0");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => composerEnterToSendPreference.set(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows usage totals and a per-model breakdown", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <UsageSettingsPanel
          usage={{
            runs: 2,
            inputTokens: 1200,
            outputTokens: 34,
            totalTokens: 1234,
            costUsd: 0.5,
            modelCalls: 3,
            models: [
              {
                provider: "openai",
                model: "model-a",
                modelCalls: 2,
                inputTokens: 1000,
                outputTokens: 30,
                totalTokens: 1030,
                costUsd: 0.5,
              },
              {
                provider: "local",
                model: "model-b",
                modelCalls: 1,
                inputTokens: 200,
                outputTokens: 4,
                totalTokens: 204,
                costUsd: null,
              },
            ],
          }}
        />,
      ),
    );
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([
      "2",
      "1,234",
      "$0.50",
    ]);
    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["model-aopenai", "2", "1,000", "30", "$0.50"],
      ["model-blocal", "1", "200", "4", "—"],
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

const point = (modelCalls: number, totalTokens: number, costUsd: number | null) => ({
  modelCalls,
  inputTokens: totalTokens - 1,
  outputTokens: 1,
  totalTokens,
  costUsd,
});

const usageFor = (input: { botId?: string; provider?: string; model?: string; range: string }) => ({
  range: input.range,
  bots: [
    { id: "bot-a", name: "Alpha", deleted: false, runs: 2, ...point(3, 400, 0.04) },
    { id: "bot-b", name: "Old bot", deleted: true, runs: 1, ...point(1, 67, 0.003) },
  ],
  modelOptions: [
    { provider: "p:1", model: "m1" },
    { provider: "p", model: "m2" },
  ],
  totals: {
    runs: input.botId ? 2 : 3,
    ...point(input.botId ? 3 : 4, input.botId ? 400 : 467, 0.04),
  },
  models: [
    { provider: input.provider ?? "p:1", model: input.model ?? "m1", ...point(3, 400, 0.04) },
  ],
  overTime: [{ date: "2026-11-10T00:00:00.000Z", ...point(3, 400, 0.04) }],
});

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function renderBreakdown() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  breakdownCalls.fetch.mockImplementation(async (input) => usageFor(input));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <UsageSettingsPanel />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("shows every bot's usage first, then narrows it by bot, model and date range", async () => {
  breakdownCalls.fetch.mockReset();
  const { container, unmount } = await renderBreakdown();
  try {
    const totals = () => [...container.querySelectorAll("dd")].map((node) => node.textContent);
    const select = (label: string) =>
      container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    const choose = async (element: HTMLSelectElement, value: string) => {
      await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    };
    expect(breakdownCalls.fetch).toHaveBeenLastCalledWith({ range: "30d" });
    expect(totals()).toEqual(["3", "467", "$0.04"]);
    expect([...select("Bot").options].map((option) => option.textContent)).toEqual([
      "All bots",
      "Alpha",
      "Old bot (deleted)",
    ]);

    await choose(select("Bot"), "bot-a");
    expect(breakdownCalls.fetch).toHaveBeenLastCalledWith({ range: "30d", botId: "bot-a" });
    expect(totals()).toEqual(["2", "400", "$0.04"]);

    // The model list keeps every model, and a model whose provider id has a colon survives.
    const first = select("Model").options[1]!.value;
    await choose(select("Model"), first);
    expect(breakdownCalls.fetch).toHaveBeenLastCalledWith({
      range: "30d",
      botId: "bot-a",
      provider: "p:1",
      model: "m1",
    });
    expect([...select("Model").options].map((option) => option.textContent)).toEqual([
      "All models",
      "m1",
      "m2",
    ]);

    const sevenDays = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "7 days",
    )!;
    await act(async () => sevenDays.click());
    await settle();
    expect(breakdownCalls.fetch).toHaveBeenLastCalledWith({
      range: "7d",
      botId: "bot-a",
      provider: "p:1",
      model: "m1",
    });
  } finally {
    await unmount();
  }
});

it("goes back to all bots when the chosen bot has no usage in the new range", async () => {
  breakdownCalls.fetch.mockReset();
  const { container, unmount } = await renderBreakdown();
  try {
    const bot = container.querySelector<HTMLSelectElement>('select[aria-label="Bot"]')!;
    await act(async () => {
      bot.value = "bot-b";
      bot.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(bot.value).toBe("bot-b");
    breakdownCalls.fetch.mockImplementation(async (input) => ({
      ...usageFor(input),
      bots: [{ id: "bot-a", name: "Alpha", deleted: false, runs: 2, ...point(3, 400, 0.04) }],
    }));
    const today = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Today",
    )!;
    await act(async () => today.click());
    await settle();
    expect(bot.value).toBe("all");
    expect(breakdownCalls.fetch).toHaveBeenLastCalledWith({ range: "today" });
  } finally {
    await unmount();
  }
});

it("does not expose server integration configuration", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <GeneralSettingsPanels name="Jamie" />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('a[href="/integrations/setup"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

async function renderNameEditor(name = "Alex Rivera") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNameSaved = vi.fn<() => Promise<void>>(async () => undefined);
  await act(async () =>
    root.render(
      <GeneralSettingsPanels name={name} email="demo@example.com" onNameSaved={onNameSaved} />,
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-testid="account-card"]')!;
  const button = (label: string) =>
    [...card.querySelectorAll("button")].find((b) => b.textContent === label)!;
  await act(async () => button("Edit").click());
  const input = card.querySelector("input")!;
  return {
    card,
    input,
    button,
    onNameSaved,
    change: async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    submit: async () =>
      act(async () => {
        card
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("saves a trimmed name and refreshes the account data", async () => {
  vi.mocked(authClient.updateUser).mockResolvedValue({ data: { status: true }, error: null });
  const editor = await renderNameEditor();
  try {
    expect(editor.input.value).toBe("Alex Rivera");
    expect(editor.input.maxLength).toBe(80);
    await editor.change("  Sam Rivera  ");
    await editor.submit();
    expect(authClient.updateUser).toHaveBeenCalledWith({ name: "Sam Rivera" });
    expect(editor.onNameSaved).toHaveBeenCalledOnce();
    expect(editor.card.querySelector("input")).toBeNull();
  } finally {
    await editor.cleanup();
  }
});

it("closes an unchanged name without saving", async () => {
  vi.mocked(authClient.updateUser).mockClear();
  const editor = await renderNameEditor();
  try {
    await editor.change("  Alex Rivera  ");
    await editor.submit();
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(editor.onNameSaved).not.toHaveBeenCalled();
    expect(editor.card.querySelector("input")).toBeNull();
    expect(editor.card.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await editor.cleanup();
  }
});

it.each(["button", "Escape"])("cancels a name edit with %s without saving", async (method) => {
  vi.mocked(authClient.updateUser).mockClear();
  const editor = await renderNameEditor();
  try {
    await editor.change("Discard me");
    await act(async () => {
      if (method === "button") editor.button("Cancel").click();
      else
        editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(editor.card.querySelector("input")).toBeNull();
    expect(editor.card.textContent).toContain("Alex Rivera");
    expect(authClient.updateUser).not.toHaveBeenCalled();
    await act(async () => editor.button("Edit").click());
    expect(editor.card.querySelector("input")!.value).toBe("Alex Rivera");
  } finally {
    await editor.cleanup();
  }
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "keeps a name edit open on the Escape that ends an IME composition (%o)",
  async (composition) => {
    const editor = await renderNameEditor();
    try {
      await editor.change("Sam Rivera");
      const pressEscape = (init: KeyboardEventInit) =>
        act(async () => {
          editor.input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }),
          );
        });
      const onWindowKey = vi.fn();
      window.addEventListener("keydown", onWindowKey);
      await pressEscape(composition);
      window.removeEventListener("keydown", onWindowKey);
      expect(editor.card.querySelector("input")?.value).toBe("Sam Rivera");
      // The form keeps Escape from chat listeners behind Settings, as a plain Escape does.
      expect(onWindowKey).not.toHaveBeenCalled();
      await pressEscape({});
      expect(editor.card.querySelector("input")).toBeNull();
    } finally {
      await editor.cleanup();
    }
  },
);

it.each(["__AbCdEfGh__", "demo", "demo@example.com"])(
  "starts hidden name %s empty and rejects invalid submissions",
  async (name) => {
    vi.mocked(authClient.updateUser).mockClear();
    const editor = await renderNameEditor(name);
    try {
      expect(editor.input.value).toBe("");
      expect(editor.button("Save").disabled).toBe(true);
      for (const value of ["", "   ", "x".repeat(81)]) {
        await editor.change(value);
        await editor.submit();
      }
      expect(authClient.updateUser).not.toHaveBeenCalled();
      expect(editor.onNameSaved).not.toHaveBeenCalled();
    } finally {
      await editor.cleanup();
    }
  },
);

it.each(["💬", "__AbCdEfGh__"])(
  "rejects unsupported name %s without losing the current name",
  async (name) => {
    vi.mocked(authClient.updateUser).mockClear();
    const editor = await renderNameEditor();
    try {
      await editor.change(name);
      await editor.submit();
      expect(authClient.updateUser).not.toHaveBeenCalled();
      expect(editor.onNameSaved).not.toHaveBeenCalled();
      expect(editor.input.value).toBe(name);
      expect(editor.card.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not update name",
      );
      await act(async () => editor.button("Cancel").click());
      expect(editor.card.textContent).toContain("Alex Rivera");
    } finally {
      await editor.cleanup();
    }
  },
);

it.each(["response", "network"])(
  "keeps the draft and shows an inline %s error",
  async (failure) => {
    if (failure === "network")
      vi.mocked(authClient.updateUser).mockRejectedValue(new Error("offline"));
    else
      vi.mocked(authClient.updateUser).mockResolvedValue({
        data: null,
        error: { status: 500, statusText: "Server error" },
      });
    const editor = await renderNameEditor();
    try {
      await editor.change("Sam Rivera");
      await editor.submit();
      expect(editor.card.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not update name",
      );
      expect(editor.input.value).toBe("Sam Rivera");
      expect(editor.button("Save").disabled).toBe(false);
      expect(editor.onNameSaved).not.toHaveBeenCalled();
    } finally {
      await editor.cleanup();
    }
  },
);

it("closes the name editor before refresh finishes and ignores a refresh failure", async () => {
  vi.mocked(authClient.updateUser).mockResolvedValue({ data: { status: true }, error: null });
  const editor = await renderNameEditor();
  let rejectRefresh!: (error: Error) => void;
  editor.onNameSaved.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectRefresh = reject;
      }),
  );
  try {
    await editor.change("Sam Rivera");
    await editor.submit();
    expect(authClient.updateUser).toHaveBeenCalledWith({ name: "Sam Rivera" });
    expect(editor.onNameSaved).toHaveBeenCalledOnce();
    expect(editor.card.querySelector("input")).toBeNull();
    expect(editor.button("Edit").disabled).toBe(false);
    await act(async () => rejectRefresh(new Error("offline")));
    expect(editor.card.querySelector("input")).toBeNull();
    expect(editor.card.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await editor.cleanup();
  }
});

it("keeps bot style available without a saved value and saves an explicit Original choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChange = vi.fn(async () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<GeneralSettingsPanels name="Tester" onBotAvatarSetChange={onChange} />);
    });
    const picker = container.querySelector('[data-testid="bot-style-select"]');
    expect(picker).not.toBeNull();
    const original = Array.from(picker!.querySelectorAll("button")).find(
      (button) => button.textContent === "Original",
    )!;
    expect(original.getAttribute("aria-pressed")).toBe("false");
    await act(async () => original.click());
    expect(onChange).toHaveBeenCalledWith("organic");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([undefined, ["social-one"], []])(
  "gates the Security group on loaded, available contents (%s)",
  async (linkedProviderIds) => {
    accountPolicy.hasPassword = false;
    accountPolicy.linkedProviderIds = linkedProviderIds;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<GeneralSettingsPanels name="Test" />));
      expect(container.textContent?.includes("Security")).toBe(linkedProviderIds?.length === 0);
      expect(container.textContent?.includes("Link Provider")).toBe(
        linkedProviderIds?.length === 0,
      );
    } finally {
      await act(async () => root.unmount());
      accountPolicy.hasPassword = true;
      accountPolicy.linkedProviderIds = undefined;
    }
  },
);
