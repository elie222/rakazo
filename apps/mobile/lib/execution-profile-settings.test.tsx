// @vitest-environment jsdom
import type { ExecutionProfile, ModelCredential } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("./i18n", () => {
  const t = (value: string, values?: Record<string, string>) =>
    value.replace(/\{(\w+)\}/g, (_, key) => values?.[key] ?? "");
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./native", () => ({
  native: { fill: "transparent" },
  useMobileTokens: () => ({
    foreground: "black",
    mutedForeground: "gray",
    border: "gray",
    destructive: "red",
  }),
}));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      disabled={editable === false}
    />
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    choices,
    value,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));

import { ExecutionProfileSettings } from "../components/execution-profile-settings";

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
];
let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "nativeLogins/list") return { enabled: false, accounts: [], computers: [] };
    if (procedure === "executionProfiles/models") return [];
    if (procedure === "executionProfiles/list") return [profile];
    if (procedure === "models/credentials") return accounts;
    if (procedure === "executionProfiles/create") return profile;
    throw new Error(`Unexpected procedure ${procedure}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value: string | null = null) {
  await act(async () => root.render(createElement(ExecutionProfileSettings, { value, onChange })));
}
function field(label: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
async function change(label: string, value: string) {
  await act(async () => {
    const element = field(label);
    const proto =
      element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill() {
  await click("New profile");
  await change("Profile name", "Review");
  await change("Provider", "anthropic");
  await change("Account", "account-b");
  await change("Model", "test-model");
  await change("Endpoint", "https://api.example.test");
}

describe("native execution profile settings", () => {
  it("clears model-scoped image declarations when the model changes", async () => {
    await render();
    await fill();
    const image = field("Model accepts images") as HTMLInputElement;
    expect(image.checked).toBe(false);
    expect(container.querySelector('[aria-label="Model accepts uploaded audio"]')).toBeNull();
    await act(async () => image.click());
    await change("Model", "another-model");
    expect(image.checked).toBe(false);
    await act(async () => image.click());
    await click("Create profile");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "executionProfiles/create",
      expect.objectContaining({ modelId: "another-model", inputModalities: ["image"] }),
    );
  });
  it("preserves a legacy Kimi binding until a new revision is explicitly created", async () => {
    const legacy: ExecutionProfile = {
      ...profile,
      harness: "kimi",
      protocol: "openai-chat-completions",
      runtimeVersion: "1.51.0",
    };
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((procedure: string) =>
      procedure === "executionProfiles/list" ? Promise.resolve([legacy]) : base(procedure),
    );
    await render(legacy.id);
    expect(container.textContent).toContain("Unsupported runtime version. Create a new revision.");
    expect(onChange).not.toHaveBeenCalled();
    await click("New revision");
    expect(field("Runtime version").value).toBe("2.2.0");
    await click("Create profile");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "executionProfiles/create",
      expect.objectContaining({
        supersedesId: legacy.id,
        runtimeVersion: "2.2.0",
        authScheme: "api-key",
        modelRoles: {},
        inputModalities: [],
      }),
    );
  });
  it("defaults to Pi and keeps advanced creation closed", async () => {
    await render();
    expect(field("Execution profile").value).toBe("");
    expect(container.querySelector('[data-testid="execution-profile-create"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Unavailable:");
  });
  it("selects an existing reusable profile without creating or changing it", async () => {
    await render();
    await change("Execution profile", profile.id);
    expect(onChange).toHaveBeenCalledWith(profile.id);
    expect(mocks.rpc).not.toHaveBeenCalledWith("executionProfiles/create", expect.anything());
  });
  it("shows the explicit account label rather than another same-provider account", async () => {
    await render(profile.id);
    const effective = container.querySelector('[data-testid="execution-profile-effective"]')!;
    expect(effective.textContent).toContain("Project account");
    expect(effective.textContent).not.toContain("Team account");
    expect(effective.textContent).not.toContain("account-b");
    expect(effective.textContent).toContain("Environment: Bot computer");
    expect(effective.textContent).toContain("Claude Agent");
    expect(effective.textContent).toContain("Unavailable: uploaded audio");
    expect(effective.textContent).toContain("Not enabled for this model: image input");
    expect(effective.textContent).toContain("Live calls use transcripts.");
    expect(effective.textContent).not.toContain("delegated agents");
  });
  it("creates with separate harness, provider, protocol and explicit account", async () => {
    await render();
    await fill();
    expect((field("Harness") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Claude Agent",
    );
    await click("Create profile");
    expect(mocks.rpc).toHaveBeenCalledWith("executionProfiles/create", {
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
  });
  it("requires explicit account selection and cancels without persisting", async () => {
    await render();
    await click("New profile");
    await change("Provider", "anthropic");
    expect(field("Account").value).toBe("");
    expect(button("Create profile").disabled).toBe(true);
    await click("Cancel");
    await click("New profile");
    expect(field("Provider").value).toBe("");
    expect(mocks.rpc).not.toHaveBeenCalledWith("executionProfiles/create", expect.anything());
  });
  it("keeps an unavailable profile selected without silently falling back", async () => {
    await render("missing-profile");
    expect(field("Execution profile").value).toBe("missing-profile");
    expect(container.textContent).toContain("This profile is unavailable");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("rejects secret-bearing endpoints before calling the server", async () => {
    await render();
    await fill();
    await change("Endpoint", "https://user:secret@api.example.test");
    await click("Create profile");
    expect(mocks.rpc).not.toHaveBeenCalledWith("executionProfiles/create", expect.anything());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("keeps the draft and old selection when creating fails", async () => {
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((procedure: string, input?: unknown) =>
      procedure === "executionProfiles/create"
        ? Promise.reject(new Error("Account unavailable"))
        : base(procedure, input),
    );
    await render();
    await fill();
    await click("Create profile");
    expect(field("Profile name").value).toBe("Review");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

it("keeps a current revision’s pinned environment and advanced authentication", async () => {
  const pinned = {
    ...profile,
    computerId: "computer-review",
    authScheme: "bearer",
    modelRoles: { haiku: "review-model" },
    inputModalities: ["image"],
  };
  const base = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((procedure: string, input?: unknown) =>
    procedure === "executionProfiles/list" ? Promise.resolve([pinned]) : base(procedure, input),
  );
  await render(profile.id);
  await click("New revision");
  await change("Profile name", "New name");
  await click("Create profile");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "executionProfiles/create",
    expect.objectContaining({
      supersedesId: profile.id,
      name: "New name",
      computerId: "computer-review",
      authScheme: "bearer",
      modelRoles: { haiku: "review-model" },
      inputModalities: ["image"],
    }),
  );
});
it("derives Pi protocol from the exact account model catalog", async () => {
  const base = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((procedure: string, input?: unknown) => {
    if (procedure === "executionProfiles/models")
      return Promise.resolve([
        {
          id: "catalog-model",
          label: "Catalog model",
          protocol: "anthropic",
          inputModalities: ["image"],
        },
      ]);
    return base(procedure, input);
  });
  await render();
  await click("New profile");
  await change("Profile name", "Pi review");
  await change("Harness", "pi");
  await change("Provider", "anthropic");
  await change("Account", "account-b");
  await change("Model", "catalog-model");
  await click("Create profile");
  expect(mocks.rpc).toHaveBeenCalledWith("executionProfiles/models", {
    harness: "pi",
    credentialId: "account-b",
  });
  expect(mocks.rpc).toHaveBeenCalledWith(
    "executionProfiles/create",
    expect.objectContaining({
      harness: "pi",
      credentialId: "account-b",
      protocol: "anthropic",
      modelId: "catalog-model",
      endpoint: null,
    }),
  );
});
it("pins signed-in native accounts and exposes their helper limitation", async () => {
  const signed = {
    ...profile,
    harness: "kimi",
    provider: "native-kimi",
    protocol: "openai-chat-completions",
    runtimeVersion: "2.2.0",
    credentialId: "signed-in",
    computerId: "computer-login",
    endpoint: "https://api.kimi.ai/coding/v1",
  };
  const base = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((procedure: string, input?: unknown) => {
    if (procedure === "executionProfiles/list") return Promise.resolve([signed]);
    if (procedure === "nativeLogins/list")
      return Promise.resolve({
        enabled: true,
        accounts: [
          {
            credentialId: "signed-in",
            label: "Personal Kimi",
            harness: "kimi",
            endpoint: signed.endpoint,
            computerId: signed.computerId,
            state: { state: "ready", accountLabel: null, plan: null },
          },
        ],
        computers: [],
      });
    return base(procedure, input);
  });
  await render(profile.id);
  expect(container.textContent).toContain(
    "Delegated agents are unavailable for signed-in accounts.",
  );
  expect(container.textContent).toContain("Personal interactive chats only.");
  expect(container.textContent).toContain("Group handoffs remain available.");
  await click("New revision");
  expect((field("Endpoint") as HTMLInputElement).disabled).toBe(true);
  await click("Create profile");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "executionProfiles/create",
    expect.objectContaining({
      credentialId: "signed-in",
      computerId: "computer-login",
      endpoint: signed.endpoint,
    }),
  );
});
