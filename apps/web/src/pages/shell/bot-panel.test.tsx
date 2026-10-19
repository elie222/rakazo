// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({
  rpc: {
    bots: { get: vi.fn(), update: vi.fn(), restoreInstructions: vi.fn() },
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
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
  Toggle: ({
    onPressedChange: _onPressedChange,
    pressed,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button type="button" aria-pressed={pressed} {...props}>
      {props.children}
    </button>
  ),
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));

import { InstructionSettings } from "../../components/InstructionSettings";
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
    fleetManagement: false,
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]) => undefined,
);

async function render(description = "Billing", overrides: Partial<Bot> = {}) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={bot(description, overrides)}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
}

function descriptionField(): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("Missing Save button");
  return found;
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

async function clickSave() {
  const before = onSave.mock.calls.length;
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (onSave.mock.calls.length === before) throw new Error("save did not run");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  vi.mocked(rpc.bots.update).mockReset();
  vi.mocked(rpc.bots.get).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BotSettings model choices", () => {
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
    await act(async () => {
      await Promise.resolve();
    });
    const model = container.querySelector("select");
    if (!(model instanceof HTMLSelectElement)) throw new Error("Missing model select");
    const values = [...model.options].map((option) => option.value);
    expect(values).toContain("deepseek::deepseek-flash");
    expect(values).toContain("deepseek::deepseek-v4-pro");
    expect(values).not.toContain("deepseek::DeepSeek-V4.1-Flash");
    expect(values.some((value) => value.includes("DeepSeek"))).toBe(false);
  });
});

describe("BotSettings thinking options", () => {
  it("preserves saved thinking on a profile save when options are hidden", async () => {
    await render("Billing", {
      modelProvider: "openai-compatible",
      modelId: "beta",
      thinkingLevel: "high",
    });
    await clickSave();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("thinkingLevel");
  });

  it("shows the connection's thinking levels for a bot on a second enabled model", async () => {
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
        thinkingLevels: ["off", "low", "high"],
      },
    ]);
    await render("Billing", { modelProvider: "openai-compatible", modelId: "beta" });
    await act(async () => {
      await Promise.resolve();
    });
    const [model, thinking] = [...container.querySelectorAll("select")];
    if (!(model instanceof HTMLSelectElement)) throw new Error("Missing model select");
    expect(model.value).toBe("openai-compatible::beta");
    if (!(thinking instanceof HTMLSelectElement)) throw new Error("Missing thinking select");
    expect([...thinking.options].map((option) => option.value)).toEqual(["", "low", "high"]);
  });
});

describe("BotSettings fleet management saves", () => {
  it("cannot restore a stale enabled value when another session disables it", async () => {
    await render("Billing", { fleetManagement: true });
    await render("Billing", { fleetManagement: false });
    await clickSave();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("fleetManagement");
  });

  it("restores the toggle when the immediate save fails", async () => {
    await render();
    onSave.mockRejectedValueOnce(new Error("offline"));
    const toggle = container.querySelector<HTMLButtonElement>('button[id$="-fleet-management"]');
    if (!toggle) throw new Error("Missing switch");
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it.each([false, true])("saves only the fleet toggle from %s", async (enabled) => {
    await render("Billing", { fleetManagement: enabled });
    const toggle = container.querySelector<HTMLButtonElement>('button[id$="-fleet-management"]');
    if (!toggle) throw new Error("Missing switch");
    await act(async () => {
      toggle.click();
    });
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ fleetManagement: !enabled });
    await clickSave();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("fleetManagement");
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");

    // The parent still passes the description from when the panel opened.
    await render();
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    await render();
    await setDescription("Billing");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await clickSave();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });
});

describe("instruction settings refresh", () => {
  it("refreshes a saved field against its latest baseline before the parent catches up", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Saved edit" });
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Saved edit");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => {
      root.render(<InstructionSettings bot={{ ...initial, instructions: "External update" }} />);
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
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, updatedAt: "2026-09-02T00:00:00.000Z" }} />,
      );
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
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, instructions: "Newer saved instructions" }} />,
      );
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
      root.render(<InstructionSettings bot={initial} />);
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
      root.render(<InstructionSettings bot={initial} />);
    });
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, instructions: "Approved replacement" }} />,
      );
    });
    expect(descriptionField().value).toBe("Approved replacement");
  });
});
