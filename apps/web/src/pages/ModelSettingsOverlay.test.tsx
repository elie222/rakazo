// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  list: vi.fn(),
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
  rpc: {
    models,
    me: vi.fn(),
  },
}));
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
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
vi.mock("@rakazo/ui-web", () => {
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
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ModelThinkingOptions: () => null,
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
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot" as const,
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

async function renderSettings() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ModelSettingsOverlay embedded onClose={() => undefined} />);
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
