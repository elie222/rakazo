// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type UiWebModule = typeof UiWeb;

const models = vi.hoisted(() => ({
  list: vi.fn(),
  backups: vi.fn(async () => []),
  setBackups: vi.fn(async () => ({ ok: true })),
  credentials: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setDefault: vi.fn(),
  probeOpenAiCompatible: vi.fn(),
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "space-1",
  rpc: {
    models,
    me: vi.fn(),
  },
}));
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
  providerRowHint: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const { Checkbox, Label, Popover, PopoverContent, PopoverTrigger } =
    await importOriginal<UiWebModule>();
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Button: ({
      children,
      onClick,
      disabled,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogDescription: ({ children }: { children?: ReactNode }) => (
      <p data-testid="model-description">{children}</p>
    ),
    Popover,
    PopoverContent,
    PopoverTrigger,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Checkbox,
    Label,
    ModelThinkingOptions: (props: {
      maxTokens?: string;
      maxTokensLabel?: string;
      onMaxTokensChange?: (value: string) => void;
    }) =>
      props.onMaxTokensChange ? (
        <input
          aria-label={props.maxTokensLabel}
          value={props.maxTokens ?? ""}
          onChange={(event) => props.onMaxTokensChange?.(event.target.value)}
        />
      ) : null,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const STORED_PLACEHOLDER = "Paste a replacement key";
const deepseekEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const compatibleEntry = {
  provider: "openai-compatible",
  providerName: "OpenAI-compatible",
  id: "custom",
  label: "Custom model",
  billing: "Your server",
  auth: "api-key" as const,
  authHint: "Custom server",
  placeholder: true,
};

function account(provider: string, modelId: string) {
  return {
    userId: "user-1",
    email: "ada@example.test",
    name: "Ada",
    spaceId: "space-1",
    isDeploymentOwner: false,
    needsModel: false,
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot" as const,
    billingEnabled: false,
    ticketBoardEnabled: false,
    phoneCallsEnabled: false,
  };
}

function buttons(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].filter((entry) =>
    entry.textContent?.includes(text),
  );
  if (found.length === 0) throw new Error(`Missing button: ${text}`);
  return found;
}

function keyField(container: HTMLElement) {
  const input = container.querySelector("#model-api-key");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key field");
  return input;
}

function compatibleKeyField(container: HTMLElement) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.getAttribute("aria-label") === "API key",
  );
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing compatible API key field");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderSettings(embedded = true, localOwner = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ModelSettingsOverlay
        embedded={embedded}
        localOwner={localOwner}
        onClose={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([]);
  models.connect.mockResolvedValue({});
  models.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("shows a stored BYOK key when provider settings reopen", async () => {
  models.credentials.mockResolvedValue([
    {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      modelId: "deepseek-chat",
    },
  ]);

  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
    expect(input.type).toBe("password");
    expect(view.container.textContent).not.toContain("sk-");
    // The Active model row is the only connection status in the connected view.
    expect(view.container.textContent).not.toContain("Connected · DeepSeek");
    expect(view.container.textContent).not.toContain("Stored securely");
    expect(view.container.textContent).not.toContain("Save limits");
    expect(buttons(view.container, "Replace API key")[0]?.disabled).toBe(true);

    await typeInto(input, "sk-replacement-key");
    expect(keyField(view.container).value).toBe("sk-replacement-key");

    await typeInto(keyField(view.container), "");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    await typeInto(keyField(view.container), "sk-replacement-key");
    await act(async () => {
      buttons(view.container, "Replace API key")[0]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", apiKey: "sk-replacement-key" }),
    );
    expect(view.container.textContent).not.toContain("Connected and using");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    models.credentials.mockResolvedValue([]);
    await act(async () => {
      buttons(view.container, "Disconnect")[0]?.click();
    });
    const confirm = buttons(view.container, "Disconnect");
    await act(async () => {
      confirm[confirm.length - 1]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.disconnect).toHaveBeenCalledWith({ provider: "deepseek" });
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe("sk-…");
  } finally {
    await view.unmount();
  }
});

it("saves an edited output limit without sending a half-typed replacement key", async () => {
  models.credentials.mockResolvedValue([
    {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      modelId: "deepseek-chat",
    },
  ]);

  const view = await renderSettings();
  try {
    const limit = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum output tokens"]',
    );
    if (!limit) throw new Error("Missing output limit field");
    await typeInto(limit, "4096");
    await typeInto(keyField(view.container), "sk-ab");
    const save = buttons(view.container, "Save").find((entry) => entry.textContent === "Save");
    await act(async () => {
      save?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.connect).toHaveBeenCalledTimes(1);
    const input = models.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ provider: "deepseek", maxTokens: 4096 });
    expect(input).not.toHaveProperty("apiKey");
    expect(keyField(view.container).value).toBe("sk-ab");
  } finally {
    await view.unmount();
  }
});

it("leaves the key field empty until a key is saved", async () => {
  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-…");
    expect(view.container.textContent).not.toContain(STORED_PLACEHOLDER);
  } finally {
    await view.unmount();
  }
});

it("shows the active model only once a model is connected", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings();
  try {
    expect(view.container.textContent).not.toContain("Active model");
  } finally {
    await view.unmount();
  }

  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  const connected = await renderSettings();
  try {
    expect(connected.container.textContent).toContain("Active model");
    expect(connected.container.textContent).toContain("DeepSeek Chat");
  } finally {
    await connected.unmount();
  }
});

it("shows Cloudflare account and gateway fields for a new and a saved connection", async () => {
  const entry = {
    provider: "cloudflare-ai-gateway",
    providerName: "Cloudflare AI Gateway",
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    label: "Llama",
    billing: "API key",
    auth: "api-key" as const,
    authHint: "API key",
  };
  vi.mocked(rpc.me).mockResolvedValue(account(entry.provider, entry.id));
  models.list.mockResolvedValue([entry]);
  models.credentials.mockResolvedValue([]);

  const fresh = await renderSettings();
  try {
    const accountId = fresh.container.querySelector("#cloudflare-account-id");
    const gatewayId = fresh.container.querySelector("#cloudflare-gateway-id");
    expect(accountId).toBeInstanceOf(HTMLInputElement);
    expect(gatewayId).toBeInstanceOf(HTMLInputElement);
    expect((accountId as HTMLInputElement).value).toBe("");
    expect((gatewayId as HTMLInputElement).value).toBe("");
    expect(fresh.container.textContent).toContain("Account ID");
    expect(fresh.container.textContent).toContain("Gateway ID");
  } finally {
    await fresh.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-cf",
      provider: entry.provider,
      label: "Cloudflare AI Gateway",
      hasKey: true,
      isDefault: true,
      accountId: "acct1234",
      gatewayId: "gateway-1",
      modelId: entry.id,
    },
  ]);
  const saved = await renderSettings();
  try {
    expect(
      (saved.container.querySelector("#cloudflare-account-id") as HTMLInputElement).value,
    ).toBe("acct1234");
    expect(
      (saved.container.querySelector("#cloudflare-gateway-id") as HTMLInputElement).value,
    ).toBe("gateway-1");
  } finally {
    await saved.unmount();
  }
});

it("shows a stored OpenAI-compatible key and stays empty when none is saved", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "deepseek-chat"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    },
  ]);

  const stored = await renderSettings();
  try {
    const input = compatibleKeyField(stored.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
  } finally {
    await stored.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    },
  ]);
  const empty = await renderSettings();
  try {
    const input = compatibleKeyField(empty.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Optional");
  } finally {
    await empty.unmount();
  }
});

it("warns only on text-only models in the picker", async () => {
  models.list.mockResolvedValue([
    { ...deepseekEntry, images: false },
    { ...deepseekEntry, id: "deepseek-vision", label: "DeepSeek Vision", images: true },
    { ...deepseekEntry, id: "deepseek-unknown", label: "DeepSeek Unknown" },
  ]);
  const view = await renderSettings();
  try {
    const describedAs = (element: Element) =>
      (element.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => (id ? document.getElementById(id)?.textContent : null))
        .filter(Boolean)
        .join(" ");
    const marked = (element: Element) =>
      Boolean(element.querySelector(`[title="Can't read images"]`));
    const trigger = view.container.querySelector('button[role="combobox"]');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing model picker");
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Chat",
      true,
      "Can't read images",
    ]);
    await act(async () => {
      trigger.click();
    });
    const options = [...document.querySelectorAll('[role="option"]')];
    // The label stays the model name; the icon is for eyes, the description for screen readers.
    expect(
      options.map((option) => [option.textContent, marked(option), describedAs(option)]),
    ).toEqual([
      ["DeepSeek Chat", true, "Can't read images"],
      ["DeepSeek Vision", false, ""],
      ["DeepSeek Unknown", false, ""],
    ]);
    await act(async () => {
      (options[1] as HTMLButtonElement).click();
    });
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Vision",
      false,
      "",
    ]);
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      (document.querySelector('[role="option"]') as HTMLButtonElement).click();
    });
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Chat",
      true,
      "Can't read images",
    ]);
  } finally {
    await view.unmount();
  }
});

it("omits the redundant description and connection prompt", async () => {
  const view = await renderSettings(false);
  try {
    expect(view.container.querySelector('[data-testid="model-description"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Choose which connected model Rakazo uses.");
    expect(view.container.textContent).not.toContain(
      "Connect this provider to use it as your personal model.",
    );
    expect(keyField(view.container)).toBeInstanceOf(HTMLInputElement);
  } finally {
    await view.unmount();
  }
});

it("keeps the server owner's description when relevant", async () => {
  const view = await renderSettings(false, true);
  try {
    expect(view.container.querySelector('[data-testid="model-description"]')?.textContent).toBe(
      "Models for the server owner’s default space.",
    );
  } finally {
    await view.unmount();
  }
});

/**
 * Accessible name per accname: aria-labelledby wins, and a labelling element's
 * text includes the control's own aria-label when the control sits inside it.
 */
function accessibleName(element: Element) {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  if (!ids.length) return element.getAttribute("aria-label") ?? "";
  return ids
    .map((id) => {
      const label = document.getElementById(id);
      if (!label) return "";
      const own = label.contains(element) ? element.getAttribute("aria-label") : null;
      return [label.textContent, own].filter(Boolean).join(" ");
    })
    .join(" ");
}

/** The checkbox whose accessible name is exactly `id`. */
function modelCheckbox(container: HTMLElement, id: string) {
  const found = [...container.querySelectorAll("[role='checkbox']")].find(
    (entry) => accessibleName(entry) === id,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`Missing model checkbox: ${id}`);
  return {
    element: found,
    get checked() {
      return found.getAttribute("aria-checked") === "true";
    },
    get disabled() {
      return found.getAttribute("aria-disabled") === "true" || found.hasAttribute("data-disabled");
    },
    click: () => found.click(),
  };
}

const compatibleCredential = {
  id: "cred-compatible",
  provider: "openai-compatible",
  label: "Local",
  hasKey: false,
  isDefault: true,
  baseUrl: "http://127.0.0.1:8000/v1",
  modelId: "model-a",
  enabledModelIds: ["model-a"],
};

async function renderCompatibleWithProbe(probed: string[]) {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([compatibleCredential]);
  models.probeOpenAiCompatible.mockResolvedValue({ models: probed });
  const view = await renderSettings();
  await act(async () => {
    buttons(view.container, "Find models")[0]?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

it("sends the ticked models other than the default when an OpenAI-compatible endpoint saves", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b", "model-c"]);
  try {
    expect(modelCheckbox(view.container, "model-b").checked).toBe(false);
    await act(async () => {
      modelCheckbox(view.container, "model-b").click();
    });
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        modelId: "model-a",
        enabledModelIds: ["model-b"],
      }),
    );
  } finally {
    await view.unmount();
  }
});

it("keeps the default model checked and disabled", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b"]);
  try {
    const defaultBox = modelCheckbox(view.container, "model-a");
    expect(defaultBox.checked).toBe(true);
    expect(defaultBox.disabled).toBe(true);
    await act(async () => {
      defaultBox.click();
    });
    expect(modelCheckbox(view.container, "model-a").checked).toBe(true);
    expect(modelCheckbox(view.container, "model-b").disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("lists saved models as checked rows before the server is probed", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const view = await renderSettings();
  try {
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
    const select = view.container.querySelector("select[aria-label='Models from server']");
    expect([...(select?.querySelectorAll("option") ?? [])].map((entry) => entry.value)).toEqual([
      "model-a",
      "model-b",
      "",
    ]);
  } finally {
    await view.unmount();
  }
});

async function chooseDefault(container: HTMLElement, id: string) {
  const select = container.querySelector("select[aria-label='Models from server']");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing model select");
  // Setting a value with no matching option would silently stage "" instead.
  if (![...select.options].some((option) => option.value === id)) {
    throw new Error(`Not a default option: ${id}`);
  }
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("allows Use this model only for a saved enabled model", async () => {
  const unsaved = await renderCompatibleWithProbe(["model-a", "model-b"]);
  try {
    await act(async () => {
      modelCheckbox(unsaved.container, "model-b").click();
    });
    await chooseDefault(unsaved.container, "model-b");
    expect(buttons(unsaved.container, "Use this model")[0]?.disabled).toBe(true);
  } finally {
    await unsaved.unmount();
  }

  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const saved = await renderSettings();
  try {
    await chooseDefault(saved.container, "model-b");
    expect(buttons(saved.container, "Use this model")[0]?.disabled).toBe(false);
  } finally {
    await saved.unmount();
  }
});

it("names each model checkbox by its id alone", async () => {
  const view = await renderCompatibleWithProbe(["model-a", "model-b"]);
  try {
    const names = [...view.container.querySelectorAll("[role='checkbox']")].map(accessibleName);
    expect(names).toEqual(["model-a", "model-b"]);
  } finally {
    await view.unmount();
  }
});

it("omits model counts and key subtitles on the OpenAI-compatible provider row", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const view = await renderSettings();
  try {
    // Provider search keeps connection details out of the row.
    const search = view.container.querySelector("#model-provider-search");
    if (!(search instanceof HTMLInputElement)) throw new Error("Missing provider search");
    await typeInto(search, "o");
    const row = [...view.container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("OpenAI-compatible"),
    );
    expect(row?.textContent).not.toMatch(/models|API key/);
  } finally {
    await view.unmount();
  }
});

it("keeps a saved model listed, unticked, after a refused save", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  models.connect.mockRejectedValue(new Error("In use by Helper"));
  const view = await renderSettings();
  try {
    await act(async () => {
      modelCheckbox(view.container, "model-b").click();
    });
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-a", enabledModelIds: [] }),
    );
    expect(view.container.textContent).toContain("In use by Helper");
    expect(modelCheckbox(view.container, "model-b").checked).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("allows Use this model for a legacy connection without a saved list", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  const { enabledModelIds: _unread, ...unreadable } = compatibleCredential;
  models.credentials.mockResolvedValue([unreadable]);
  models.probeOpenAiCompatible.mockResolvedValue({ models: ["model-a", "model-b"] });
  const view = await renderSettings();
  try {
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      modelCheckbox(view.container, "model-b").click();
    });
    await chooseDefault(view.container, "model-b");
    expect(buttons(view.container, "Use this model")[0]?.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

function baseUrlField(container: HTMLElement) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.value === compatibleCredential.baseUrl,
  );
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing server URL field");
  return input;
}

it("drops the saved ticks and rows when the server URL changes, and restores them on the saved URL", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const view = await renderSettings();
  try {
    const field = baseUrlField(view.container);
    await typeInto(field, "http://other.test/v1");
    expect(() => modelCheckbox(view.container, "model-b")).toThrow();
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://other.test/v1", enabledModelIds: [] }),
    );
    await typeInto(field, compatibleCredential.baseUrl);
    expect(modelCheckbox(view.container, "model-b").checked).toBe(true);
  } finally {
    await view.unmount();
  }
});
