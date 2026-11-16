// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import type { Bot, BotAvatarSet } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => {
  const rpc = {
    bots: {
      get: vi.fn(),
      update: vi.fn(),
      restoreInstructions: vi.fn(),
      // Saved instructions mark the roster stale; nothing here reads it.
      list: vi.fn(async () => []),
      // This server receives no email, so the panel offers no address.
      emailAddress: vi.fn(async () => null),
    },
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const { OptionSelect } = await importOriginal<typeof UiWeb>();
  const { createContext, useContext } = await import("react");
  const PopoverOpen = createContext<(open: boolean) => void>(() => undefined);
  return {
    useCopyText: () => [false, () => {}],
    SectionHeading: ({
      variant: _variant,
      ...props
    }: ComponentProps<"h3"> & { variant?: string }) => <h3 {...props} />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    OptionSelect,
    Switch: ({
      onCheckedChange,
      checked,
      ...props
    }: ComponentProps<"button"> & {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      />
    ),
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { variant?: string }) => <button type="button" {...props} />,
    Popover: ({
      onOpenChange,
      children,
    }: {
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <PopoverOpen.Provider value={onOpenChange}>{children}</PopoverOpen.Provider>,
    PopoverTrigger: (props: ComponentProps<"button">) => {
      const setOpen = useContext(PopoverOpen);
      return <button type="button" {...props} onClick={() => setOpen(true)} />;
    },
    PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandEmpty: () => null,
    CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandItem: ({
      value,
      onSelect,
      ...props
    }: Omit<ComponentProps<"button">, "onSelect"> & { value: string; onSelect: () => void }) => (
      <button type="button" role="option" data-value={value} onClick={onSelect} {...props} />
    ),
    ListSearchInput: () => null,
  };
});
vi.mock("../../components/pages/PagesList", () => ({ PagesList: () => null }));
vi.mock("./avatar-studio-popover", () => ({
  AvatarStudioPopover: ({
    value,
    avatarSet,
    onChange,
  }: {
    value: string;
    avatarSet?: BotAvatarSet;
    onChange: (value: string, avatarSet?: BotAvatarSet) => void;
  }) => (
    <>
      <button
        type="button"
        aria-label="Avatar color"
        data-color={value}
        onClick={() => onChange(value === "blue" ? "ink" : "blue")}
      />
      <button
        type="button"
        aria-label="Avatar set"
        data-avatar-set={avatarSet}
        data-color={value}
        onClick={() => onChange("#F97316", avatarSet === "rakazo" ? "organic" : "rakazo")}
      />
    </>
  ),
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => <h3>Open work</h3> }));
vi.mock("../KnowledgeSection", () => ({
  KnowledgeSection: () => <h3>Memory and skills</h3>,
}));

import { InstructionSettings } from "../../components/InstructionSettings";
import { spaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const longInstructions = "I".repeat(4_000);

function bot(description = "Billing", overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Ada",
    title: "Helper",
    description,
    instructions: longInstructions,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    fleetManagement: true,
    replyMode: "chat",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]) => undefined,
);
const onExport = vi.fn(async () => undefined);

async function render(description = "Billing", overrides: Partial<Bot> = {}, focusModel = 0) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotSettings
          focusModel={focusModel}
          bot={bot(description, overrides)}
          onSave={onSave}
          onExport={onExport}
          onClear={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  await act(flush);
}

function descriptionField(): HTMLTextAreaElement {
  const textarea =
    container.querySelector<HTMLTextAreaElement>('textarea[id$="-description"]') ??
    container.querySelector("textarea");
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

async function setDescription(value: string) {
  const textarea = descriptionField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Flips Notifications, which saves the whole profile at once. */
async function saveProfile() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[id$="-notify-finish"]')!.click();
  });
}

async function openSettings() {
  await act(async () => settingsButton().click());
}

function settingsButton() {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="bot-settings-advanced"] button',
  )!;
}

async function openModelPicker() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[id$="-model"]')!.click(),
  );
  return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

function thinkingField() {
  return container.querySelector<HTMLElement>('[role="combobox"][id$="-thinking"]')!;
}

async function openOptions(trigger: HTMLElement) {
  await act(async () => trigger.click());
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}

async function selectThinking(label: string) {
  const option = (await openOptions(thinkingField())).find((entry) => entry.textContent === label);
  await act(async () => option?.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  onExport.mockReset().mockResolvedValue(undefined);
  vi.mocked(rpc.bots.update).mockReset();
  vi.mocked(rpc.bots.get).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the profile and folds the settings away", async () => {
  await render("Billing");
  expect(container.querySelector('[data-testid="bot-profile-header"]')?.textContent).toContain(
    "Ada",
  );
  expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
  expect(container.querySelector('[role="tab"]')).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Save"),
  ).toBe(false);
  const settings = document.getElementById(settingsButton().getAttribute("aria-controls")!)!;
  expect(settingsButton().getAttribute("aria-expanded")).toBe("false");
  expect(settings.hidden).toBe(true);
  await openSettings();
  expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
  expect(settings.hidden).toBe(false);
  expect(settings.querySelector('textarea[id$="-instructions"]')).not.toBeNull();
  expect(settings.querySelector('[data-testid="bot-settings-tools"]')).toBeNull();
  const card = settings.firstElementChild!;
  expect(
    [...card.querySelectorAll('label, button[id$="-model"]')].map(
      (node) => node.firstChild?.textContent,
    ),
  ).toEqual(["Model", "Notifications", "Own computer"]);
});

describe("BotSettings model choices", () => {
  it("offers an email address under the name until the bot has one", async () => {
    vi.mocked(rpc.bots.emailAddress).mockResolvedValueOnce({ domain: "bots.test", address: null });
    await render();
    const offer = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Get an email address",
    );
    expect(document.querySelector('[data-testid="bot-email"]')).toBeNull();
    await act(async () => offer?.click());
    expect(document.querySelector<HTMLInputElement>('[data-testid="bot-email"] input')?.value).toBe(
      "ada",
    );

    vi.mocked(rpc.bots.emailAddress).mockResolvedValueOnce({
      domain: "bots.test",
      address: "scout@bots.test",
    });
    queryClient.clear();
    await render();
    expect(document.querySelector('[data-testid="bot-email"]')?.textContent).toContain(
      "scout@bots.test",
    );
  });

  it("submits DeepSeek API ids and does not offer a display label", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "cred-deepseek",
        provider: "deepseek",
        label: "DeepSeek",
        hasKey: true,
        isDefault: true,
        modelId: "DeepSeek-V4.1-Flash",
      },
    ]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        billing: "",
      },
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        billing: "",
      },
    ]);
    await render();
    await act(() => flush());
    const values = (await openModelPicker()).map((option) => option.dataset.value);
    expect(values).toContain("deepseek::deepseek-flash");
    expect(values).toContain("deepseek::deepseek-v4-pro");
    expect(values).not.toContain("deepseek::DeepSeek-V4.1-Flash");
    expect(values.some((value) => value?.includes("DeepSeek"))).toBe(false);
  });
});

describe("BotSettings thinking options", () => {
  it("preserves saved thinking on a profile save when options are hidden", async () => {
    await render("Billing", {
      modelProvider: "openai-compatible",
      modelId: "beta",
      thinkingLevel: "high",
    });
    await saveProfile();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("thinkingLevel");
  });

  it("shows the thinking levels the bot's own model offers on its connection", async () => {
    i18n.load("en", {});
    i18n.activate("en");
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "newer",
        provider: "openai-compatible",
        label: "Newer",
        hasKey: true,
        isDefault: false,
        enabledModelIds: ["beta"],
        thinkingLevels: ["off"],
      },
      {
        id: "cred-compatible",
        provider: "openai-compatible",
        label: "Local server",
        hasKey: true,
        isDefault: true,
        modelId: "alpha",
        enabledModelIds: ["alpha", "beta"],
        apiProtocol: "anthropic-messages",
        modelSettings: { beta: { reasoning: true } },
      },
    ]);
    await render("Billing", { modelProvider: "openai-compatible", modelId: "beta" });
    await act(() => flush());
    const checked = (await openModelPicker()).find((option) => option.dataset.checked === "true");
    expect(checked?.dataset.value).toBe("openai-compatible::beta");
    expect((await openOptions(thinkingField())).map((option) => option.textContent)).toEqual([
      "Default (Medium)",
      "Minimal",
      "Low",
      "Medium",
      "High",
    ]);
  });
});

describe("BotSettings model autosave", () => {
  async function renderWithModels() {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "cred-compatible",
        provider: "openai-compatible",
        label: "Local server",
        hasKey: true,
        isDefault: true,
        modelId: "alpha",
        enabledModelIds: ["alpha", "beta"],
        apiProtocol: "anthropic-messages",
        modelSettings: { beta: { reasoning: true } },
      },
    ]);
    await render("Billing", { modelProvider: "openai-compatible", modelId: "beta" });
    await act(() => flush());
  }

  it("saves a thinking change at once and puts back a refused one", async () => {
    await renderWithModels();
    await selectThinking("High");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ modelId: "beta", thinkingLevel: "high" });
    onSave.mockRejectedValueOnce(new Error("offline"));
    await selectThinking("Low");
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ thinkingLevel: "low" });
    expect(thinkingField().textContent).toBe("High");
    expect(container.textContent).toContain("offline");
  });

  it("saves a model change at once and puts back a refused one", async () => {
    await renderWithModels();
    const alpha = (await openModelPicker()).find(
      (option) => option.dataset.value === "openai-compatible::alpha",
    );
    await act(async () => alpha!.click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "alpha",
    });
    onSave.mockRejectedValueOnce(new Error("offline"));
    const beta = (await openModelPicker()).find(
      (option) => option.dataset.value === "openai-compatible::beta",
    );
    await act(async () => beta!.click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ modelId: "beta" });
    const checked = (await openModelPicker()).find((option) => option.dataset.checked === "true");
    expect(checked?.dataset.value).toBe("openai-compatible::alpha");
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("saves Own computer at once and puts back a refused change", async () => {
    await render();
    const toggle = () => container.querySelector<HTMLButtonElement>('button[id$="-own-computer"]')!;
    await act(async () => toggle().click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ computerMode: "dedicated" });
    onSave.mockRejectedValueOnce(new Error("offline"));
    await act(async () => toggle().click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ computerMode: "team" });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});

describe("BotSettings bot management saves", () => {
  it("cannot restore a stale enabled value when another session disables it", async () => {
    await render("Billing", { fleetManagement: true });
    await render("Billing", { fleetManagement: false });
    await saveProfile();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("fleetManagement");
  });

  it("restores the toggle when the immediate save fails", async () => {
    await render("Billing", { fleetManagement: false });
    onSave.mockRejectedValueOnce(new Error("offline"));
    const toggle = container.querySelector<HTMLButtonElement>('button[id$="-fleet-management"]');
    if (!toggle) throw new Error("Missing switch");
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a failed export instead of leaving it unhandled", async () => {
    await render();
    onExport.mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 }));
    const exportButton = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Export",
    );
    if (!exportButton) throw new Error("Missing export");
    await act(async () => {
      exportButton.click();
    });
    expect(container.textContent).toContain("Could not reach the server");
  });

  it("saves only the bot management toggle, both ways", async () => {
    await render("Billing", { fleetManagement: false });
    const toggle = container.querySelector<HTMLButtonElement>('button[id$="-fleet-management"]');
    if (!toggle) throw new Error("Missing switch");
    await act(async () => toggle.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ fleetManagement: true });
    await act(async () => toggle.click());
    expect(onSave).toHaveBeenLastCalledWith({ fleetManagement: false });
    await saveProfile();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("fleetManagement");
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await saveProfile();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await saveProfile();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");

    // The parent still passes the description from when the panel opened.
    await render();
    await saveProfile();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await saveProfile();
    await render();
    await setDescription("Billing");
    await saveProfile();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await saveProfile();
    await saveProfile();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });
});

describe("instruction settings refresh", () => {
  const instructions = (shown: Bot) => (
    <QueryClientProvider client={queryClient}>
      <InstructionSettings bot={shown} />
    </QueryClientProvider>
  );
  it("refreshes a saved field against its latest baseline before the parent catches up", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Saved edit" });
    await act(async () => {
      root.render(instructions(initial));
    });
    await setDescription("Saved edit");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => {
      root.render(instructions({ ...initial, instructions: "External update" }));
    });
    expect(descriptionField().value).toBe("External update");
    await setDescription("Fresh edit");
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Fresh edit" });
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenLastCalledWith({
      botId: initial.id,
      instructions: "Fresh edit",
      expectedInstructions: "External update",
    });
  });
  it("keeps a dirty draft when run completion refreshes the bot", async () => {
    const initial = bot();
    await act(async () => {
      root.render(instructions(initial));
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(instructions({ ...initial, updatedAt: "2026-09-02T00:00:00.000Z" }));
    });
    expect(descriptionField().value).toBe("Unsaved instructions");
  });
  it("saves the original draft baseline after a newer instruction refresh", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({
      ...initial,
      instructions: "Unsaved instructions",
    });
    await act(async () => {
      root.render(instructions(initial));
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(instructions({ ...initial, instructions: "Newer saved instructions" }));
    });
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenCalledWith({
      botId: initial.id,
      instructions: "Unsaved instructions",
      expectedInstructions: initial.instructions,
    });
  });
  it("reloads the current instructions and baseline after a conflict", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockRejectedValueOnce(
      new ORPCError("CONFLICT", { message: "Instructions changed" }),
    );
    vi.mocked(rpc.bots.get)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...initial,
        instructions: "Newer saved instructions",
      });
    await act(async () => {
      root.render(instructions(initial));
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const reload = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    );
    if (!reload) throw new Error("Missing reload action");
    expect(descriptionField().value).toBe("Unsaved instructions");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      reload.click();
    });
    expect(descriptionField().value).toBe("Unsaved instructions");
    expect(container.textContent).toContain("Reload");
    await act(async () => {
      reload.click();
    });
    expect(descriptionField().value).toBe("Newer saved instructions");
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Fresh draft" });
    await setDescription("Fresh draft");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenLastCalledWith({
      botId: initial.id,
      instructions: "Fresh draft",
      expectedInstructions: "Newer saved instructions",
    });
  });
  it("refreshes pristine instructions after an external update", async () => {
    const initial = bot();
    await act(async () => {
      root.render(instructions(initial));
    });
    await act(async () => {
      root.render(instructions({ ...initial, instructions: "Approved replacement" }));
    });
    expect(descriptionField().value).toBe("Approved replacement");
  });
});

it("cancels an inline name edit", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
  );
  const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  expect(input.value).toBe("Ada");
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(container.querySelector('[aria-label="Name"]')).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});

it("focuses the model control for a model deep link", async () => {
  await render("", {}, 1);
  expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.id.endsWith("-model")).toBe(true);
});

it("saves inline name edits on blur and on Enter", async () => {
  await render();
  for (const [value, event] of [
    ["Atlas", new FocusEvent("focusout", { bubbles: true })],
    ["Ada", new KeyboardEvent("keydown", { key: "Enter", bubbles: true })],
  ] as const) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(event));
    expect(onSave.mock.lastCall?.[0]).toHaveProperty("name", value);
  }
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "keeps an inline name edit open on IME Enter and Escape (%o)",
  async (composition) => {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Atlas",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const windowKeys: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => windowKeys.push(event.key);
    window.addEventListener("keydown", onWindowKey);
    for (const key of ["Enter", "Escape"]) {
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...composition })),
      );
    }
    window.removeEventListener("keydown", onWindowKey);
    expect(container.querySelector('[aria-label="Name"]')).toBe(input);
    // A composing Escape must not reach page-level Escape listeners such as the reply chip.
    expect(windowKeys).not.toContain("Escape");
    expect(onSave).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave.mock.lastCall?.[0]).toHaveProperty("name", "Atlas");
  },
);

it.each(["color", "notifyOnFinish"])(
  "restores the last accepted %s after an automatic save fails",
  async (field) => {
    await render();
    const control = () =>
      container.querySelector<HTMLButtonElement>(
        field === "color" ? '[aria-label="Avatar color"]' : 'button[id$="-notify-finish"]',
      )!;
    const value = () => control().getAttribute(field === "color" ? "data-color" : "aria-checked");
    await act(async () => control().click());
    expect(value()).toBe(field === "color" ? "blue" : "false");
    onSave.mockRejectedValueOnce(new Error("offline"));
    await act(async () => control().click());
    expect(value()).toBe(field === "color" ? "blue" : "false");
    expect(container.textContent).toContain("offline");
    expect(
      [...container.querySelectorAll("button")].some((node) => node.textContent === "Save"),
    ).toBe(false);
  },
);

it("saves a color change back to the initial value after a successful automatic save", async () => {
  await render();
  const control = () => container.querySelector<HTMLButtonElement>('[aria-label="Avatar color"]')!;
  await act(async () => control().click());
  await act(async () => control().click());
  expect(onSave.mock.lastCall?.[0]).toHaveProperty("color", "ink");
});

describe("BotSettings avatar set persistence", () => {
  it("interprets a legacy missing set as Original without saving a replacement", async () => {
    await render();
    expect(
      container.querySelector('[aria-label="Avatar set"]')?.getAttribute("data-avatar-set"),
    ).toBe("organic");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves an explicit set switch atomically with its generated colour and retains it after reload", async () => {
    await render("Billing", { color: "#10B981" });
    const control = () => container.querySelector<HTMLButtonElement>('[aria-label="Avatar set"]')!;
    await act(async () => control().click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ avatarSet: "rakazo", color: "#F97316" });
    expect(control().getAttribute("data-avatar-set")).toBe("rakazo");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render("Billing", { color: "#F97316", avatarSet: "rakazo" });
    expect(control().getAttribute("data-avatar-set")).toBe("rakazo");
  });

  it("restores the accepted colour and set when switching fails", async () => {
    await render("Billing", { color: "#10B981" });
    onSave.mockRejectedValueOnce(new Error("offline"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Avatar set"]')!.click(),
    );
    const control = container.querySelector('[aria-label="Avatar set"]')!;
    expect(control.getAttribute("data-avatar-set")).toBe("organic");
    expect(control.getAttribute("data-color")).toBe("#10B981");
    expect(container.textContent).toContain("offline");
  });

  it("keeps a colour edit in its existing set", async () => {
    await render("Billing", { avatarSet: "rakazo" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Avatar color"]')!.click(),
    );
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("avatarSet");
    expect(
      container.querySelector('[aria-label="Avatar set"]')?.getAttribute("data-avatar-set"),
    ).toBe("rakazo");
  });
});

describe("BotSettings cached data", () => {
  it("shows cached voices at once and refreshes them in the background", async () => {
    queryClient.setQueryData(spaceQueries(null, null).voice.voices.queryKey({ input: {} }), [
      { id: "cached-voice", label: "Cached voice" },
    ]);
    vi.mocked(rpc.voice.voices)
      .mockClear()
      .mockReturnValueOnce(new Promise(() => undefined));
    await render("Billing", { autoSpeak: true });
    const voices = await openOptions(
      container.querySelector<HTMLElement>('[role="combobox"][id$="-voice"]')!,
    );
    expect(voices.map((option) => option.textContent)).toContain("Cached voice");
    expect(rpc.voice.voices).toHaveBeenCalledTimes(1);
  });

  it("follows a newer bot in fields not edited and keeps the ones that were", async () => {
    await render("Billing", { computerMode: "team" });
    await setDescription("Invoices");
    await render("Remote edit", {
      name: "Grace",
      computerMode: "dedicated",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(container.querySelector('[aria-label="Edit name"]')?.textContent).toBe("Grace");
    expect(descriptionField().value).toBe("Invoices");
    await saveProfile();
    const patch = onSave.mock.lastCall?.[0];
    expect(patch).toMatchObject({ description: "Invoices", computerMode: "dedicated" });
    expect(patch).not.toHaveProperty("name");
  });
});
