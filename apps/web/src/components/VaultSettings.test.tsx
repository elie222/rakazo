// @vitest-environment jsdom

import type { SettingsScope } from "@rakazo/contracts";
import { encodeLoginSecret } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  list: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  reveal: vi.fn(),
}));

// The dialog itself is tested on its own; here it is a pair of buttons that settle it.
vi.mock("./ConfirmIdentityDialog", async () => {
  const { useState } = await import("react");
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => {
      const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
      const done = (confirmed: boolean) => {
        settle?.(confirmed);
        setSettle(null);
      };
      return {
        withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
          runWithIdentityConfirmation(
            action,
            () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
          ),
        identityDialog: settle ? (
          <div data-testid="identity-dialog">
            <button type="button" data-testid="identity-confirm" onClick={() => done(true)} />
            <button type="button" data-testid="identity-cancel" onClick={() => done(false)} />
          </div>
        ) : null,
      };
    },
  };
});

vi.mock("../lib/rpc", () => ({
  rpc: { vault },
  rpcForSpace: () => ({ vault }),
  createSpaceRpc: () => ({ vault }),
  selectedSpaceId: () => null,
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
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Label: ({ htmlFor: _htmlFor, ...props }: ComponentProps<"label">) => <span {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    size: _size,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    size?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import { REVEAL_MS, VaultSettings } from "./VaultSettings";

const FAKE_VALUE = "fake-value-SENTINEL-1";
const stamp = "2026-09-01T00:00:00.000Z";
const rows = [
  { name: "api", origin: "https://api.example.com", auth: { type: "bearer" } },
  {
    name: "custom",
    origin: "https://svc.example.com",
    auth: { type: "header", name: "X-Api-Key" },
  },
  {
    name: "router",
    origin: "http://192.168.1.20:8080",
    auth: { type: "basic", username: "admin" },
  },
  { name: "portal", origin: "https://portal.example.com", auth: { type: "login" } },
].map((row) => ({ ...row, createdAt: stamp, updatedAt: stamp }));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(scope: SettingsScope = "account") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <VaultSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function byTestId<T extends HTMLElement>(testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found;
}

async function type(testId: string, value: string) {
  const element = byTestId<HTMLInputElement | HTMLSelectElement>(testId);
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function click(testId: string) {
  await act(async () => {
    byTestId<HTMLButtonElement>(testId).click();
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vault.list.mockReset().mockResolvedValue(rows);
  vault.put.mockReset();
  vault.remove.mockReset().mockResolvedValue({ ok: true });
  vault.reveal.mockReset();
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

describe("VaultSettings", () => {
  it("lists credential metadata and no values", async () => {
    await render();
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "account" });
    const text = container.textContent ?? "";
    expect(container.querySelectorAll('[data-testid="vault-credential-row"]')).toHaveLength(4);
    for (const expected of [
      "https://api.example.com",
      "Bearer token",
      'Header "X-Api-Key"',
      "http://192.168.1.20:8080",
      "Basic auth (admin)",
      "Website login",
    ]) {
      expect(text).toContain(expected);
    }
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows only the add action until there is something to list", async () => {
    vault.list.mockResolvedValue([]);
    await render();
    expect(byTestId("credential-add").textContent).toBe("Add credential");
    expect(container.querySelector('[data-testid="vault-card"]')).toBeNull();
    await click("credential-add");
    const form = byTestId("vault-card").querySelector('[data-testid="credential-add-form"]');
    expect(form).not.toBeNull();
    // The form has its own save and cancel, so the add action steps aside while it is open.
    expect(container.querySelector('[data-testid="credential-add"]')).toBeNull();
  });

  it("reads and writes the Space's own vault when scoped to the Space", async () => {
    vault.put.mockResolvedValue(rows[0]);
    await render("space");
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "space" });
    await click("credential-replace-api");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");
    expect(vault.put).toHaveBeenCalledWith({
      scope: "space",
      destination: { name: "api", origin: "https://api.example.com", auth: { type: "bearer" } },
      value: FAKE_VALUE,
    });
    await click("credential-remove-custom");
    await click("credential-remove-confirm-custom");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "space", name: "custom" });
  });

  it("adds a header credential and clears the value, then refetches", async () => {
    const savedHeader = rows[1];
    if (!savedHeader) throw new Error("missing header fixture");
    let resolvePut: (row: typeof savedHeader) => void = () => undefined;
    vault.put.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "custom");
    await type("credential-origin", "https://svc.example.com");
    await type("credential-auth-type", "header");
    await type("credential-header-name", "X-Api-Key");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-value").type).toBe("password");
    expect(byTestId<HTMLInputElement>("credential-value").autocomplete).toBe("new-password");
    await click("credential-add-save");
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);

    await act(async () => {
      resolvePut(savedHeader);
    });
    await flush();

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "custom",
        origin: "https://svc.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      value: FAKE_VALUE,
    });
    expect(vault.list).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears the value and shows the server error when saving fails", async () => {
    vault.put.mockRejectedValue(
      new Error("Invalid credential destination — origin: Expected an HTTPS origin"),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "router2");
    await type("credential-origin", "http://192.168.1.21");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledTimes(1);
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid credential destination",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  const loginRows = () => [
    ...container.querySelectorAll<HTMLElement>('[data-testid="login-field"]'),
  ];

  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function fillLoginRow(index: number, label: string, value: string) {
    const row = () => loginRows()[index]!;
    await setInput(row().querySelector<HTMLInputElement>('input[aria-label="Label"]')!, label);
    await setInput(row().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!, value);
  }

  async function clickButton(row: HTMLElement, selector: string) {
    await act(async () => row.querySelector<HTMLElement>(selector)!.click());
  }

  it("encodes a website login's fields with encodeLoginSecret", async () => {
    vault.put.mockResolvedValue(rows[3]);
    await render();
    await click("credential-add");
    await type("credential-name", "portal2");
    await type("credential-origin", "https://portal.example.com");
    await type("credential-auth-type", "login");

    expect(
      loginRows().map((row) => [
        row.querySelector<HTMLInputElement>('input[aria-label="Label"]')!.value,
        row.querySelector('[role="switch"]')!.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["Username", "false"],
      ["Password", "true"],
    ]);
    await fillLoginRow(0, "Account number", " 12345678 ");
    await fillLoginRow(1, "Password", FAKE_VALUE);
    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Add field")!.click();
    });
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(true);
    await fillLoginRow(2, "Postcode", "AB1 2CD");
    expect(
      loginRows()[2]!.querySelector<HTMLInputElement>('input[aria-label="Postcode"]')!.type,
    ).toBe("password");
    await clickButton(loginRows()[2]!, '[role="switch"]');
    expect(
      loginRows()[2]!.querySelector<HTMLInputElement>('input[aria-label="Postcode"]')!.type,
    ).toBe("text");
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "portal2",
        origin: "https://portal.example.com",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({
        fields: [
          { label: "Account number", value: "12345678", hidden: false },
          { label: "Password", value: FAKE_VALUE, hidden: true },
          { label: "Postcode", value: "AB1 2CD", hidden: false },
        ],
      }),
    });
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("can't save a login until every field has its own label and a value", async () => {
    await render();
    await click("credential-add");
    await type("credential-name", "portal2");
    await type("credential-origin", "https://portal.example.com");
    await type("credential-auth-type", "login");
    await fillLoginRow(0, "Code", "fake-code");
    await fillLoginRow(1, "code", FAKE_VALUE);
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(true);

    await clickButton(loginRows()[1]!, '[aria-label="Remove"]');
    expect(loginRows()).toHaveLength(1);
    expect(loginRows()[0]!.querySelector('[aria-label="Remove"]')).toBeNull();
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(false);
  });

  it("replaces a value on the same destination", async () => {
    vault.put.mockResolvedValue(rows[2]);
    await render();
    const replace = byTestId<HTMLButtonElement>("credential-replace-router");
    expect(replace.getAttribute("aria-label")).toBe("Replace value");
    expect(replace.textContent).toBe("");
    expect(replace.querySelector("svg")).not.toBeNull();
    const remove = byTestId<HTMLButtonElement>("credential-remove-router");
    expect(remove.getAttribute("aria-label")).toBe("Remove");
    expect(remove.textContent).toBe("");
    await click("credential-replace-router");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: { type: "basic", username: "admin" },
      },
      value: FAKE_VALUE,
    });
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows an unreadable saved row with remove but no replace", async () => {
    vault.list.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "Legacy Name" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it("hides replace and shows the unreadable row when a readable auth has an invalid name", async () => {
    vault.list.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: { type: "bearer" },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "Legacy Name" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the add form open when save succeeds but list reload fails", async () => {
    vault.put.mockResolvedValue(rows[0]);
    vault.list.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error("list failed"));
    await render();
    await click("credential-add");
    await type("credential-name", "api2");
    await type("credential-origin", "https://api.example.com");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="credential-add-form"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load credentials.",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears a typed replace value when opening remove on another row", async () => {
    await render();
    await click("credential-replace-api");
    await type("credential-replace-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-replace-value").value).toBe(FAKE_VALUE);
    await click("credential-remove-custom");
    expect(container.querySelector('[data-testid="credential-replace-value"]')).toBeNull();
    expect(container.textContent).toContain("Remove custom?");
    // Protected value must not linger in any live input.
    const leaked = Array.from(container.querySelectorAll("input, textarea")).some((input) =>
      (input as HTMLInputElement).value.includes(FAKE_VALUE),
    );
    expect(leaked).toBe(false);
  });

  it("removes only after an explicit confirm", async () => {
    await render();
    await click("credential-remove-api");
    expect(vault.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove api?");
    await click("credential-remove-confirm-api");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "api" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });
});

describe("VaultSettings command variables", () => {
  const commandRow = {
    name: "netbird-setup-key",
    origin: "",
    auth: { type: "command" },
    createdAt: stamp,
    updatedAt: stamp,
  };

  it("adds a command variable with no origin and shows its derived name", async () => {
    vault.put.mockResolvedValue(commandRow);
    await render();
    await click("credential-add");
    await type("credential-origin", "https://leftover.example.com");
    await type("credential-auth-type", "command");
    expect(container.querySelector('[data-testid="credential-origin"]')).toBeNull();
    await type("credential-name", "netbird-setup-key");
    expect(byTestId("credential-command-variable").textContent).toContain("$NETBIRD_SETUP_KEY");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(false);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(vault.put.mock.calls[0]![0].destination).not.toHaveProperty("origin");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows the blocklist error and cannot save a reserved name", async () => {
    await render();
    await click("credential-add");
    await type("credential-auth-type", "command");
    await type("credential-name", "ld_preload");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId("credential-command-variable-error").textContent).toContain(
      "$LD_PRELOAD is reserved",
    );
    expect(container.querySelector('[data-testid="credential-command-variable"]')).toBeNull();
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(true);
    await act(async () => {
      byTestId<HTMLFormElement>("credential-add-form").requestSubmit();
    });
    await flush();
    expect(vault.put).not.toHaveBeenCalled();
  });

  it("lists a command variable with its variable name and replaces its value", async () => {
    vault.list.mockResolvedValue([commandRow]);
    vault.put.mockResolvedValue(commandRow);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("Command variable$NETBIRD_SETUP_KEY");
    await click("credential-replace-netbird-setup-key");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
  });
});

describe("VaultSettings show", () => {
  const confirmationRequired = Object.assign(new Error("Confirm it's you"), {
    code: "IDENTITY_CONFIRMATION_REQUIRED",
  });
  const text = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  const shown = () => container.querySelector('[data-testid="credential-revealed"]');

  it("shows a value with a copy button, then hides it on request", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vault.reveal.mockResolvedValue({ value: FAKE_VALUE });
    await render();
    expect(byTestId("credential-show-api").getAttribute("aria-label")).toBe("Show");
    await click("credential-show-api");
    expect(vault.reveal).toHaveBeenCalledWith({ scope: "account", name: "api" });
    expect(text("credential-revealed-value")).toBe(FAKE_VALUE);
    expect(byTestId("credential-show-api").getAttribute("aria-label")).toBe("Hide");
    // A shown value never lands in the query cache.
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    expect(JSON.stringify(cached)).not.toContain(FAKE_VALUE);

    await act(async () => {
      shown()?.querySelector<HTMLButtonElement>('[aria-label="Copy"]')?.click();
    });
    expect(writeText).toHaveBeenCalledWith(FAKE_VALUE);

    await click("credential-show-api");
    expect(shown()).toBeNull();
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows each field of a website login with its label", async () => {
    vault.reveal.mockResolvedValue({
      fields: [
        { label: "Username", value: "jamie", hidden: false },
        { label: "PIN", value: FAKE_VALUE, hidden: true },
      ],
    });
    await render();
    await click("credential-show-portal");
    expect(
      [...container.querySelectorAll('[data-testid="credential-revealed-field"]')].map(
        (field) => field.parentElement!.textContent,
      ),
    ).toEqual(["Usernamejamie", `PIN${FAKE_VALUE}`]);
  });

  it("asks the person to confirm it's them, then retries", async () => {
    vault.reveal
      .mockRejectedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ value: FAKE_VALUE });
    await render();
    await click("credential-show-api");
    expect(byTestId("identity-dialog")).toBeTruthy();
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
    await click("identity-confirm");
    expect(vault.reveal).toHaveBeenCalledTimes(2);
    expect(text("credential-revealed-value")).toBe(FAKE_VALUE);
    expect(container.querySelector('[data-testid="identity-dialog"]')).toBeNull();
  });

  it("shows nothing and no error when the confirmation is dismissed", async () => {
    vault.reveal.mockRejectedValue(confirmationRequired);
    await render();
    await click("credential-show-api");
    await click("identity-cancel");
    expect(vault.reveal).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("hides the value after a while and when another row action opens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vault.reveal.mockResolvedValue({ value: FAKE_VALUE });
      await render();
      await click("credential-show-api");
      expect(text("credential-revealed-value")).toBe(FAKE_VALUE);
      await act(async () => {
        vi.advanceTimersByTime(REVEAL_MS);
      });
      expect(shown()).toBeNull();

      await click("credential-show-api");
      expect(text("credential-revealed-value")).toBe(FAKE_VALUE);
      await click("credential-replace-custom");
      expect(shown()).toBeNull();
      expect(container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending show without asking to confirm once another action opens", async () => {
    let reject: (error: unknown) => void = () => undefined;
    vault.reveal.mockReturnValueOnce(
      new Promise((_resolve, rejectReveal) => {
        reject = rejectReveal;
      }),
    );
    await render();
    await click("credential-show-api");
    expect(byTestId<HTMLButtonElement>("credential-show-custom").disabled).toBe(true);
    await click("credential-replace-custom");
    // Cancelling frees the other Show actions right away.
    expect(byTestId<HTMLButtonElement>("credential-show-api").disabled).toBe(false);
    await act(async () => reject(confirmationRequired));
    await flush();
    expect(container.querySelector('[data-testid="identity-dialog"]')).toBeNull();
    expect(vault.reveal).toHaveBeenCalledTimes(1);
    expect(byTestId("credential-replace-value")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers no show on a row whose saved settings can't be read", async () => {
    vault.list.mockResolvedValue([
      {
        name: "legacy",
        origin: "https://legacy.example.com",
        auth: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    await render();
    expect(container.querySelector('[data-testid="credential-show-legacy"]')).toBeNull();
  });
});
