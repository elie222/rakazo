// @vitest-environment jsdom

import type { ProviderSettingsField } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { ProviderSettingsForm } from "./ProviderSettingsForm";

const secret = (label: string, mode: string, required: boolean): ProviderSettingsField => ({
  key: "apiKey",
  label,
  kind: "secret",
  required,
  placeholder: "key_…",
  minLength: 8,
  maxLength: 64,
  visibleWhen: { key: "mode", equals: mode },
});

/** One field of every kind, with the rules the real providers use. */
const fields: ProviderSettingsField[] = [
  secret("Hosted key", "cloud", true),
  secret("Server key", "local", false),
  {
    key: "mode",
    label: "Connection",
    kind: "select",
    required: true,
    default: "cloud",
    options: [
      { value: "cloud", label: "Cloud" },
      { value: "local", label: "Self-hosted" },
    ],
    advanced: true,
    scopesSecrets: true,
  },
  {
    key: "baseUrl",
    label: "Base URL",
    kind: "url",
    required: true,
    placeholder: "https://…",
    advanced: true,
    visibleWhen: { key: "mode", equals: "local" },
    scopesSecrets: true,
  },
  {
    key: "team",
    label: "Team",
    kind: "text",
    required: false,
    description: "Shared with this team.",
    checks: [{ pattern: "^[a-z-]+$", message: "Lowercase letters only." }],
    advanced: true,
    scopesSecrets: true,
  },
  {
    key: "sources",
    label: "Sources",
    kind: "list",
    required: false,
    advanced: true,
    scopesSecrets: true,
  },
  { key: "learn", label: "Learn", kind: "toggle", required: true, default: "true", advanced: true },
];

const named: ProviderSettingsField[] = [
  {
    key: "endpoint",
    label: "Endpoint",
    kind: "text",
    required: true,
    requiredMessage: "An endpoint is required.",
    scopesSecrets: true,
  },
  { key: "token", label: "Token", kind: "secret", required: true, minLength: 8 },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof ProviderSettingsForm>[0]> = {}) {
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(
      <ProviderSettingsForm
        fields={fields}
        busy={false}
        advancedSettings={<p>Scope</p>}
        onSubmit={onSubmit}
        {...props}
      />,
    ),
  );
  return onSubmit;
}

function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function labelled(name: string) {
  const label = [...host.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === name,
  );
  return label ? (host.querySelector(`#${CSS.escape(label.htmlFor)}`) as HTMLElement) : null;
}

function input(name: string) {
  const found = labelled(name);
  if (!(found instanceof HTMLInputElement)) throw new Error(`No input labelled ${name}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function type(name: string, value: string) {
  const field = input(name);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("draws every kind of field, with the advanced ones behind their section", async () => {
  await render();
  const key = input("Hosted key");
  expect(key.type).toBe("password");
  expect(key.placeholder).toBe("key_…");
  expect(key.maxLength).toBe(64);
  expect(key.autocomplete).toBe("new-password");
  expect(labelled("Team")).toBeNull();
  expect(host.textContent).not.toContain("Scope");
  expect(button("Connect").disabled).toBe(true);

  await click(button("Advanced"));
  // What the screen adds to the section comes ahead of the provider's own fields.
  expect(host.textContent?.indexOf("Scope")).toBeLessThan(host.textContent!.indexOf("Connection"));
  expect(button("Cloud").getAttribute("aria-pressed")).toBe("true");
  expect(button("Self-hosted").getAttribute("aria-pressed")).toBe("false");
  expect(labelled("Base URL")).toBeNull();
  expect(input("Team").type).toBe("text");
  expect(input("Team").getAttribute("aria-describedby")).toBe(
    [...host.querySelectorAll("p")].find((p) => p.textContent === "Shared with this team.")?.id,
  );
  const learn = host.querySelector<HTMLElement>('[role="switch"]')!;
  expect(document.getElementById(learn.getAttribute("aria-labelledby")!)?.textContent).toBe(
    "Learn",
  );
  expect(learn.getAttribute("aria-checked")).toBe("true");

  await type("Hosted key", "key_12345678");
  await type("Sources", " notes, ,journal ");
  await click(learn);
  expect(learn.getAttribute("aria-checked")).toBe("false");
  const onSubmit = await render();
  await click(button("Connect"));
  expect(onSubmit).toHaveBeenCalledWith({
    settings: { mode: "cloud", sources: "notes,journal", learn: "false" },
    credentials: { apiKey: "key_12345678" },
  });
});

it("switches connection mode: another key label, a base URL, and a key that may stay empty", async () => {
  const onSubmit = await render();
  await click(button("Advanced"));
  await type("Hosted key", "key_12345678");
  const key = input("Hosted key");

  await click(button("Self-hosted"));
  expect(button("Self-hosted").getAttribute("aria-pressed")).toBe("true");
  expect(labelled("Hosted key")).toBeNull();
  // The same input under its other label, so what was typed stays.
  expect(input("Server key")).toBe(key);
  expect(key.value).toBe("key_12345678");
  expect(input("Base URL").placeholder).toBe("https://…");
  expect(input("Base URL").required).toBe(true);
  expect(button("Connect").disabled).toBe(true);

  await type("Base URL", " http://10.0.0.8:6767 ");
  await type("Server key", "");
  expect(button("Connect").disabled).toBe(false);
  await type("Server key", "short");
  expect(button("Connect").disabled).toBe(true);
  await type("Server key", "");
  await click(button("Connect"));
  expect(onSubmit).toHaveBeenCalledWith({
    settings: { mode: "local", baseUrl: "http://10.0.0.8:6767", learn: "true" },
    credentials: {},
  });

  await click(button("Cloud"));
  expect(labelled("Base URL")).toBeNull();
  expect(button("Connect").disabled).toBe(true);
});

it("keeps a saved secret that is left untouched until what it reaches changes", async () => {
  const saved = { mode: "cloud", team: "ops", sources: "notes", learn: "false" };
  const onSubmit = await render({ saved, advancedSettings: null });
  expect(input("Hosted key").value).toBe("");
  expect(input("Hosted key").placeholder).toBe("Saved");
  expect(button("Save").disabled).toBe(false);

  await click(button("Advanced"));
  expect(input("Team").value).toBe("ops");
  expect(input("Sources").value).toBe("notes");
  expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await click(host.querySelector<HTMLElement>('[role="switch"]')!);
  await click(button("Save"));
  expect(onSubmit).toHaveBeenLastCalledWith({
    settings: { mode: "cloud", team: "ops", sources: "notes", learn: "true" },
    credentials: {},
  });

  await type("Sources", "notes,journal");
  expect(input("Hosted key").placeholder).toBe("key_…");
  expect(button("Save").disabled).toBe(true);
  await type("Hosted key", "key_replacement");
  await click(button("Save"));
  expect(onSubmit).toHaveBeenLastCalledWith({
    settings: { mode: "cloud", team: "ops", sources: "notes,journal", learn: "true" },
    credentials: { apiKey: "key_replacement" },
  });

  // A self-hosted server may have no key saved, so its optional key never claims one.
  await type("Sources", "notes");
  await click(button("Self-hosted"));
  expect(input("Server key").placeholder).toBe("key_…");
});

it("shows a field's own checks as it is typed, and holds the button", async () => {
  await render();
  await click(button("Advanced"));
  await type("Hosted key", "key_12345678");
  await type("Team", "Ops");
  const team = input("Team");
  expect(team.getAttribute("aria-invalid")).toBe("true");
  const error = [...host.querySelectorAll("[id]")].find(
    (element) => element.textContent === "Lowercase letters only.",
  );
  expect(team.getAttribute("aria-describedby")?.split(" ")).toContain(error?.id);
  expect(button("Connect").disabled).toBe(true);

  await type("Team", "ops");
  expect(team.getAttribute("aria-invalid")).toBeNull();
  expect(host.textContent).not.toContain("Lowercase letters only.");
  expect(button("Connect").disabled).toBe(false);
});

it("says a required field is missing on submit when the field has words for it", async () => {
  const onSubmit = await render({ fields: named, advancedSettings: null });
  expect(() => button("Advanced")).toThrow();
  expect(button("Connect").disabled).toBe(true);
  await type("Token", "token_12345678");
  expect(button("Connect").disabled).toBe(false);
  expect(host.textContent).not.toContain("An endpoint is required.");

  await click(button("Connect"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(host.textContent).toContain("An endpoint is required.");
  expect(input("Endpoint").getAttribute("aria-invalid")).toBe("true");

  await type("Endpoint", "not a url");
  expect(host.textContent).not.toContain("An endpoint is required.");
  await click(button("Connect"));
  expect(onSubmit).toHaveBeenCalledWith({
    settings: { endpoint: "not a url" },
    credentials: { token: "token_12345678" },
  });
});

it("holds every control while a save is in flight", async () => {
  await render({ busy: true });
  expect(button("Connecting…").disabled).toBe(true);
  expect(input("Hosted key").disabled).toBe(true);
  await render({ busy: true, saved: { mode: "cloud" } });
  expect(button("Saving…").disabled).toBe(true);
});
