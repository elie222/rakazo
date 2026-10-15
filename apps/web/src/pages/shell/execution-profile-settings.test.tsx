// @vitest-environment jsdom
import type { ExecutionProfile, ModelCredential } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  credentials: vi.fn(),
  create: vi.fn(),
  models: vi.fn(),
  nativeLogins: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    executionProfiles: { list: mocks.list, create: mocks.create, models: mocks.models },
    models: { credentials: mocks.credentials },
    nativeLogins: { list: mocks.nativeLogins },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "type" | "onChange"> & {
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { ExecutionProfileSettings } from "./execution-profile-settings";

const profile: ExecutionProfile = {
  id: "profile-a",
  seriesId: "series-a",
  spaceId: "space-a",
  revision: 1,
  name: "Review",
  harness: "claude",
  runtimeVersion: "0.3.300",
  provider: "anthropic",
  protocol: "anthropic",
  credentialId: "account-b",
  endpoint: "https://api.example.test",
  modelId: "test-model",
  authScheme: "api-key",
  modelRoles: {},
  inputModalities: [],
  computerId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const accounts: ModelCredential[] = [
  {
    id: "account-a",
    provider: "anthropic",
    label: "Team account",
    hasKey: true,
    isDefault: true,
    authKind: "api_key",
  },
  {
    id: "account-b",
    provider: "anthropic",
    label: "Project account",
    hasKey: true,
    isDefault: false,
    authKind: "api_key",
  },
  {
    id: "account-c",
    provider: "openai",
    label: "Other account",
    hasKey: true,
    isDefault: false,
    authKind: "api_key",
  },
];
let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.list.mockResolvedValue([profile]);
  mocks.credentials.mockResolvedValue(accounts);
  mocks.create.mockResolvedValue(profile);
  mocks.models.mockResolvedValue([]);
  mocks.nativeLogins.mockResolvedValue({ enabled: false, accounts: [], computers: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value: string | null = null, currentProfile?: ExecutionProfile) {
  await act(async () =>
    root.render(
      <ExecutionProfileSettings
        value={value}
        currentProfile={currentProfile}
        onChange={onChange}
      />,
    ),
  );
}
function field<T extends HTMLInputElement | HTMLSelectElement>(suffix: string) {
  const result = container.querySelector<T>(`[id$="-${suffix}"]`);
  if (!result) throw new Error(`Missing field ${suffix}`);
  return result;
}
async function change(suffix: string, value: string) {
  await act(async () => {
    const element = field(suffix);
    const proto =
      element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill() {
  await click("New profile");
  await change("name", "Review");
  await change("provider", "anthropic");
  await change("account", "account-b");
  await change("model", "test-model");
  await change("endpoint", "https://api.example.test");
}

describe("execution profile settings", () => {
  it("binds media declarations to the selected model and resets them after model changes", async () => {
    await render();
    await fill();
    const image = container.querySelector<HTMLInputElement>('[aria-label="Model accepts images"]')!;
    expect(image.checked).toBe(false);
    expect(container.querySelector('[aria-label="Model accepts uploaded audio"]')).toBeNull();
    await act(async () => image.click());
    await change("model", "another-model");
    expect(image.checked).toBe(false);
    await act(async () => image.click());
    await click("Create profile");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "another-model", inputModalities: ["image"] }),
    );
  });
  it("offers Codex native audio only on custom Responses endpoints", async () => {
    await render();
    await fill();
    await change("harness", "codex");
    await change("provider", "openai");
    await change("account", "account-c");
    await change("model", "test-model");
    await change("endpoint", "https://api.openai.com/v1");
    expect(container.querySelector('[aria-label="Model accepts uploaded audio"]')).toBeNull();
    await change("endpoint", "https://api.example.test/v1");
    const audio = container.querySelector<HTMLInputElement>(
      '[aria-label="Model accepts uploaded audio"]',
    )!;
    await act(async () => audio.click());
    await click("Create profile");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ inputModalities: ["audio"] }),
    );
  });
  it("keeps legacy Kimi selected until a new pinned revision is explicitly created", async () => {
    const legacy: ExecutionProfile = {
      ...profile,
      harness: "kimi",
      protocol: "openai-chat-completions",
      runtimeVersion: "1.51.0",
    };
    mocks.list.mockResolvedValue([legacy]);
    await render(legacy.id);
    expect(container.textContent).toContain("Unsupported runtime version. Create a new revision.");
    expect(container.textContent).toContain("Kimi Code");
    expect(onChange).not.toHaveBeenCalled();
    await click("New revision");
    expect(field<HTMLInputElement>("version").value).toBe("2.2.0");
    await click("Create profile");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        supersedesId: legacy.id,
        runtimeVersion: "2.2.0",
        authScheme: "api-key",
        modelRoles: {},
        inputModalities: [],
      }),
    );
  });
  it("keeps Pi the default without creating a profile or choosing an account", async () => {
    await render();
    expect(field<HTMLSelectElement>("profile").value).toBe("");
    expect(container.querySelector('[data-testid="execution-profile-effective"]')).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Unavailable:");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows only the exact bound account and safe effective configuration", async () => {
    await render(profile.id);
    const effective = container.querySelector('[data-testid="execution-profile-effective"]')!;
    expect(effective.textContent).toContain("Project account");
    expect(effective.textContent).not.toContain("Team account");
    expect(effective.textContent).toContain("Bot computer");
    expect(effective.textContent).toContain("Claude Agent");
    expect(effective.textContent).toContain("Unavailable: uploaded audio");
    expect(effective.textContent).toContain("Not enabled for this model: image input");
    expect(effective.textContent).toContain("Live calls use transcripts.");
    expect(effective.textContent).not.toContain("delegated agents");
    expect(effective.textContent).toContain("anthropic");
    expect(effective.textContent).not.toContain("account-b");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
  it("creates a reusable profile with explicitly chosen account and separate protocol", async () => {
    await render();
    await fill();
    expect(field<HTMLSelectElement>("harness").selectedOptions[0]?.textContent).toBe(
      "Claude Agent",
    );
    await click("Create profile");
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Review",
      harness: "claude",
      runtimeVersion: "0.3.300",
      provider: "anthropic",
      credentialId: "account-b",
      protocol: "anthropic",
      endpoint: "https://api.example.test",
      modelId: "test-model",
      authScheme: "api-key",
      modelRoles: {},
      inputModalities: [],
      computerId: null,
    });
    expect(onChange).toHaveBeenCalledWith(profile.id);
    expect(container.querySelector('[data-testid="execution-profile-create"]')).toBeNull();
  });
  it("clears the account when its provider changes and requires explicit reselection", async () => {
    await render();
    await fill();
    await change("provider", "openai");
    expect(field<HTMLSelectElement>("account").value).toBe("");
    expect(field<HTMLInputElement>("model").value).toBe("");
    expect(button("Create profile").disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires a fresh account choice when changing harness and uses its pinned protocol/version", async () => {
    await render();
    await fill();
    await change("harness", "codex");
    expect(field<HTMLSelectElement>("account").value).toBe("");
    expect(field<HTMLSelectElement>("protocol").value).toBe("openai-responses");
    expect(field<HTMLInputElement>("version").value).toBe("0.162.1");
    expect(field<HTMLInputElement>("version").readOnly).toBe(true);
    expect(button("Create profile").disabled).toBe(true);
  });
  it("does not fall back when a profile or exact account is unavailable", async () => {
    mocks.credentials.mockResolvedValue([accounts[0]]);
    await render(profile.id);
    expect(container.textContent).toContain("This profile’s account is unavailable");
    expect(onChange).not.toHaveBeenCalled();
    await render("missing-profile");
    expect(field<HTMLSelectElement>("profile").value).toBe("missing-profile");
    expect(container.textContent).toContain("This profile is unavailable");
  });
  it("preserves selection after loading failure and can retry", async () => {
    mocks.list.mockRejectedValueOnce(new Error("offline"));
    await render(profile.id, profile);
    expect(field<HTMLSelectElement>("profile").value).toBe(profile.id);
    expect(container.textContent).toContain("Could not load execution profiles");
    expect(button("New profile").disabled).toBe(true);
    await click("Retry");
    expect(button("New profile").disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("retains the form after a rejected create without binding anything", async () => {
    mocks.create.mockRejectedValueOnce(new Error("Account unavailable"));
    await render();
    await fill();
    await click("Create profile");
    expect(container.querySelector('[data-testid="execution-profile-create"]')).not.toBeNull();
    expect(field<HTMLInputElement>("name").value).toBe("Review");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("rejects endpoint credentials locally without transmitting them", async () => {
    await render();
    await fill();
    await change("endpoint", "https://api.example.test/v1?token=fake-sensitive-value");
    await click("Create profile");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("without credentials");
  });
  it("cancels without persisting and clears the draft on reopen", async () => {
    await render();
    await fill();
    await click("Cancel");
    await click("New profile");
    expect(field<HTMLInputElement>("name").value).toBe("");
    expect(field<HTMLSelectElement>("account").value).toBe("");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("ignores repeated create and a late result after navigating away", async () => {
    let finish!: (value: ExecutionProfile) => void;
    mocks.create.mockReturnValue(
      new Promise<ExecutionProfile>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await fill();
    await act(async () => {
      button("Create profile").click();
      button("Create profile").click();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    await act(async () => finish(profile));
    expect(onChange).not.toHaveBeenCalled();
  });
});

it("revises a current profile without losing its account, environment or model declarations", async () => {
  const pinned = {
    ...profile,
    computerId: "computer-review",
    inputModalities: ["image"] as const,
    authScheme: "bearer" as const,
    modelRoles: { sonnet: "review-model" },
  };
  mocks.list.mockResolvedValue([pinned]);
  await render(profile.id);
  await click("New revision");
  await change("name", "Review updated");
  await click("Create profile");
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      supersedesId: profile.id,
      name: "Review updated",
      credentialId: "account-b",
      computerId: "computer-review",
      inputModalities: ["image"],
      authScheme: "bearer",
      modelRoles: { sonnet: "review-model" },
    }),
  );
  expect(container.textContent).not.toContain("Unsupported runtime version");
});
it("derives Pi protocol from the selected catalog model and accepts an exact OAuth account", async () => {
  mocks.credentials.mockResolvedValue([
    { ...accounts[2], id: "oauth-account", authKind: "oauth", modelId: "responses-model" },
  ]);
  mocks.models.mockResolvedValue([
    {
      id: "responses-model",
      label: "Responses model",
      protocol: "openai-responses",
      inputModalities: ["image"],
    },
    {
      id: "chat-model",
      label: "Chat model",
      protocol: "openai-chat-completions",
      inputModalities: [],
    },
  ]);
  await render();
  await click("New profile");
  await change("name", "Pi project");
  await change("harness", "pi");
  await change("provider", "openai");
  await change("account", "oauth-account");
  expect(mocks.models).toHaveBeenCalledWith({ harness: "pi", credentialId: "oauth-account" });
  expect(field<HTMLSelectElement>("protocol").value).toBe("openai-responses");
  expect(field<HTMLSelectElement>("protocol").disabled).toBe(true);
  expect(container.querySelector('[id$="-endpoint"]')).toBeNull();
  await change("model-choice", "chat-model");
  await click("Create profile");
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      harness: "pi",
      credentialId: "oauth-account",
      modelId: "chat-model",
      protocol: "openai-chat-completions",
      endpoint: null,
    }),
  );
});
it("blocks unsupported Pi account protocols before creating a profile", async () => {
  await render();
  await click("New profile");
  await change("name", "Unsupported");
  await change("harness", "pi");
  await change("provider", "anthropic");
  await change("account", "account-b");
  expect(container.textContent).toContain(
    "This account’s protocol is not supported by execution profiles.",
  );
  expect(button("Create profile").disabled).toBe(true);
});
it("uses compatible Pi chat-completions for an explicitly entered model", async () => {
  mocks.credentials.mockResolvedValue([
    {
      ...accounts[2],
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
      modelId: "saved-model",
    },
  ]);
  mocks.models.mockResolvedValue([
    {
      id: "saved-model",
      label: "Saved model",
      protocol: "openai-chat-completions",
      inputModalities: [],
    },
  ]);
  await render();
  await click("New profile");
  await change("name", "Pi compatible");
  await change("harness", "pi");
  await change("provider", "openai-compatible");
  await change("account", "account-c");
  await change("model-choice", "");
  await change("model", "custom-model");
  await click("Create profile");
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: "openai-chat-completions",
      modelId: "custom-model",
      endpoint: "https://gateway.example.test/v1",
    }),
  );
});
it("ignores a stale model catalog after switching account", async () => {
  let finish!: (value: unknown[]) => void;
  mocks.models
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce([
      { id: "other", label: "Other", protocol: "anthropic", inputModalities: [] },
    ]);
  await render();
  await fill();
  await change("account", "account-a");
  await act(async () =>
    finish([{ id: "stale", label: "Stale", protocol: "anthropic", inputModalities: ["image"] }]),
  );
  expect(field<HTMLSelectElement>("model-choice").textContent).not.toContain("Stale");
  expect(field<HTMLSelectElement>("model-choice").textContent).toContain("Other");
});
it("pins a signed-in account to its official endpoint and computer without API credentials", async () => {
  mocks.nativeLogins.mockResolvedValue({
    enabled: true,
    accounts: [
      {
        credentialId: "signed-in",
        label: "Personal Codex",
        harness: "codex",
        endpoint: "https://chatgpt.com/backend-api/codex",
        computerId: "computer-login",
        state: { state: "ready", accountLabel: null, plan: null },
      },
    ],
    computers: [{ id: "computer-login", scope: "team", botName: null }],
  });
  await render();
  await click("New profile");
  await change("name", "Personal review");
  await change("harness", "codex");
  await change("provider", "native-codex");
  await change("account", "signed-in");
  await change("model", "gpt-test");
  expect(field<HTMLInputElement>("endpoint").readOnly).toBe(true);
  expect(field<HTMLSelectElement>("environment").disabled).toBe(true);
  expect(field<HTMLSelectElement>("environment").value).toBe("computer-login");
  expect(container.querySelector('[aria-label="Model accepts uploaded audio"]')).toBeNull();
  await click("Create profile");
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      credentialId: "signed-in",
      provider: "native-codex",
      computerId: "computer-login",
      endpoint: "https://chatgpt.com/backend-api/codex",
    }),
  );
});
it("offers only the signed-in account’s matching harness and a ready state", async () => {
  mocks.nativeLogins.mockResolvedValue({
    enabled: true,
    accounts: [
      {
        credentialId: "signed-in",
        label: "Personal Codex",
        harness: "codex",
        endpoint: "https://chatgpt.com/backend-api/codex",
        computerId: "computer-login",
        state: { state: "ready", accountLabel: null, plan: null },
      },
    ],
    computers: [],
  });
  await render();
  await click("New profile");
  expect(field<HTMLSelectElement>("provider").textContent).not.toContain("native-codex");
  await change("harness", "pi");
  expect(field<HTMLSelectElement>("provider").textContent).not.toContain("native-codex");
});

it("keeps signed-in profile limitations visible when its account is unavailable", async () => {
  const signed = { ...profile, provider: "native-kimi", harness: "kimi" as const };
  mocks.list.mockResolvedValue([signed]);
  await render(signed.id);
  expect(container.textContent).toContain(
    "Delegated agents are unavailable for signed-in accounts.",
  );
  expect(container.textContent).toContain("Group handoffs remain available.");
  expect(container.textContent).toContain("Personal interactive chats only.");
});
