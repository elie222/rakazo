// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backupApi = vi.hoisted(() => ({
  me: vi.fn(),
  backups: vi.fn(),
  setBackups: vi.fn(),
  selectedSpaceId: vi.fn(() => "space-a"),
  translate: (parts: TemplateStringsArray, ...values: string[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));

vi.mock("../lib/rpc", () => ({
  rpc: {
    me: backupApi.me,
    models: { backups: backupApi.backups, setBackups: backupApi.setBackups },
  },
  selectedSpaceId: backupApi.selectedSpaceId,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: backupApi.translate }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />;
  const Div = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button,
    DropdownMenu: Div,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuGroup: Div,
    DropdownMenuLabel: ({ children }: { children?: ReactNode }) => (
      <div data-testid="menu-label">{children}</div>
    ),
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({
      render: _render,
      ...props
    }: ComponentProps<"button"> & { render?: ReactNode }) => <button {...props} />,
  };
});

import { ModelBackupsSettings } from "./ModelBackupsSettings";

const scope = { userId: "user-a", spaceId: "space-a" };
const catalog = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet",
    label: "Claude Sonnet",
    billing: "",
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt-test",
    label: "GPT test",
    billing: "",
  },
];
const credentials = [
  {
    id: "anthropic-credential",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
  },
  { id: "openai-credential", provider: "openai", label: "OpenAI", hasKey: true, isDefault: false },
];

let container: HTMLDivElement;
let root: Root;

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

function backupRows(): string[] {
  return [...container.querySelectorAll('[data-testid^="model-backup-"]')].map(
    (row) => row.firstElementChild?.firstElementChild?.textContent ?? "",
  );
}

async function clickButton(name: string): Promise<void> {
  await act(async () => button(name).click());
}

function menuItems(): string[] {
  return [...container.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
}

async function addBackup(label: string): Promise<void> {
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!item) throw new Error(`Missing model option: ${label}`);
  await act(async () => item.click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderSettings(props: Partial<ComponentProps<typeof ModelBackupsSettings>> = {}) {
  await act(async () => {
    root.render(
      <ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} {...props} />,
    );
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  backupApi.me.mockReset().mockResolvedValue({ userId: scope.userId, spaceId: scope.spaceId });
  backupApi.backups.mockReset().mockResolvedValue([]);
  backupApi.setBackups.mockReset().mockResolvedValue({ ok: true });
  backupApi.selectedSpaceId.mockReturnValue(scope.spaceId);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ModelBackupsSettings", () => {
  it("retries a failed initial load without replacing unseen backups", async () => {
    backupApi.backups
      .mockRejectedValueOnce(new Error("Temporary load failure"))
      .mockResolvedValueOnce([{ provider: "openai", modelId: "gpt-test" }]);
    await renderSettings();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Temporary load failure");
    await clickButton("Retry");
    await flush();
    expect(backupRows()).toEqual(["OpenAI · GPT test"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(backupApi.backups).toHaveBeenCalledTimes(2);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });

  it("offers no editing after a failed load so an unseen saved list cannot be replaced", async () => {
    backupApi.backups.mockRejectedValueOnce(new Error("Load failed")).mockResolvedValueOnce([]);
    await renderSettings();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Load failed");
    expect(container.textContent).not.toContain("Add backup model");
    expect(menuItems()).toEqual([]);
    expect(backupApi.setBackups).not.toHaveBeenCalled();

    await clickButton("Retry");
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Add backup model").disabled).toBe(false);
    await addBackup("Claude Sonnet");
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledWith(
      [{ provider: "anthropic", modelId: "claude-sonnet" }],
      { context: { spaceId: scope.spaceId } },
    );
  });

  it("explains backups and groups addable models by provider", async () => {
    await renderSettings();
    const section = container.querySelector('[data-testid="model-backups"]');
    expect(section?.getAttribute("aria-labelledby")).toBe("model-backups-title");
    expect(section?.querySelector("h3#model-backups-title")?.textContent).toBe("Backup models");
    expect(container.textContent).toContain("Tried in order if the active model fails.");
    expect(button("Add backup model").disabled).toBe(false);
    expect(
      [...container.querySelectorAll('[data-testid="menu-label"]')].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Anthropic", "OpenAI"]);
    expect(menuItems()).toEqual(["Claude Sonnet", "GPT test"]);
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("Save");
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });

  it("omits provider labels when only one provider is connected", async () => {
    await renderSettings({ credentials: [credentials[0]!] });
    expect(container.querySelector('[data-testid="menu-label"]')).toBeNull();
    expect(menuItems()).toEqual(["Claude Sonnet"]);
  });

  it("hides the section while loading and when there is nothing to configure", async () => {
    const load = deferred<never[]>();
    backupApi.backups.mockReturnValueOnce(load.promise);
    await renderSettings({ credentials: [] });
    expect(container.querySelector('[data-testid="model-backups"]')).toBeNull();
    await act(async () => load.resolve([]));
    await flush();
    expect(container.querySelector('[data-testid="model-backups"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("saves every add, move, and remove immediately in order", async () => {
    await renderSettings();

    await addBackup("Claude Sonnet");
    await flush();
    await addBackup("GPT test");
    await flush();
    expect(backupRows()).toEqual(["Anthropic · Claude Sonnet", "OpenAI · GPT test"]);
    expect(container.textContent).not.toContain("Add backup model");

    await clickButton("Move OpenAI · GPT test up");
    await flush();
    expect(backupRows()).toEqual(["OpenAI · GPT test", "Anthropic · Claude Sonnet"]);
    expect(button("Move OpenAI · GPT test up").disabled).toBe(true);
    expect(button("Move Anthropic · Claude Sonnet down").disabled).toBe(true);
    await clickButton("Remove Anthropic · Claude Sonnet");
    await flush();
    expect(backupRows()).toEqual(["OpenAI · GPT test"]);
    expect(() => button("Move OpenAI · GPT test up")).toThrow();

    const anthropic = { provider: "anthropic", modelId: "claude-sonnet" };
    const openai = { provider: "openai", modelId: "gpt-test" };
    expect(backupApi.setBackups.mock.calls.map(([choices]) => choices)).toEqual([
      [anthropic],
      [anthropic, openai],
      [openai, anthropic],
      [openai],
    ]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("serializes rapid edits so the server ends at the latest list", async () => {
    const first = deferred<{ ok: true }>();
    backupApi.setBackups.mockReturnValueOnce(first.promise);
    await renderSettings();

    await addBackup("Claude Sonnet");
    await flush();
    await addBackup("GPT test");
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledTimes(1);
    expect(backupRows()).toEqual(["Anthropic · Claude Sonnet", "OpenAI · GPT test"]);

    await act(async () => first.resolve({ ok: true }));
    await flush();
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledTimes(2);
    expect(backupApi.setBackups.mock.calls[1]?.[0]).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "openai", modelId: "gpt-test" },
    ]);
  });

  it("reloads the saved order and saves removal of a disconnected entry", async () => {
    backupApi.backups.mockResolvedValue([
      { provider: "openai", modelId: "gpt-test" },
      { provider: "disconnected-provider", modelId: "old-model" },
    ]);
    await renderSettings();

    expect(backupRows()).toEqual(["OpenAI · GPT test", "disconnected-provider · old-model"]);
    expect(container.textContent).toContain("Not connected");
    await clickButton("Remove disconnected-provider · old-model");
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledWith(
      [{ provider: "openai", modelId: "gpt-test" }],
      { context: { spaceId: scope.spaceId } },
    );
  });

  it("reverts to the saved list and shows the error when a save fails", async () => {
    backupApi.backups.mockResolvedValue([{ provider: "anthropic", modelId: "claude-sonnet" }]);
    const save = deferred<never>();
    backupApi.setBackups.mockReturnValueOnce(save.promise);
    await renderSettings();
    await addBackup("GPT test");
    expect(backupRows()).toEqual(["Anthropic · Claude Sonnet", "OpenAI · GPT test"]);
    await act(async () =>
      save.reject(new Error("Backup model choices must be unique (maximum 10).")),
    );
    await flush();

    expect(backupRows()).toEqual(["Anthropic · Claude Sonnet"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Backup model choices must be unique (maximum 10).",
    );
    expect(() => button("Retry")).toThrow();
    expect(menuItems()).toEqual(["GPT test"]);
  });

  it("keeps saving queued edits after leaving Models and reloads only once they land", async () => {
    const first = deferred<{ ok: true }>();
    backupApi.setBackups.mockReturnValueOnce(first.promise);
    await renderSettings();
    await addBackup("Claude Sonnet");
    await flush();
    await addBackup("GPT test");
    await flush();

    await act(async () => root.render(<div />));
    await act(async () => first.resolve({ ok: true }));
    await flush();
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledTimes(2);
    expect(backupApi.setBackups.mock.calls[1]?.[0]).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "openai", modelId: "gpt-test" },
    ]);
  });

  it("waits for pending saves before reloading the list", async () => {
    const save = deferred<{ ok: true }>();
    backupApi.setBackups.mockReturnValueOnce(save.promise);
    await renderSettings();
    await addBackup("Claude Sonnet");
    await flush();

    await act(async () => root.render(<div />));
    backupApi.backups.mockClear();
    await renderSettings();
    expect(backupApi.backups).not.toHaveBeenCalled();

    await act(async () => save.resolve({ ok: true }));
    await flush();
    await flush();
    expect(backupApi.backups).toHaveBeenCalledTimes(1);
  });

  it("saves an old-space edit to its own space, never the newly selected one", async () => {
    let resolveOldSpaceMe: ((value: { userId: string; spaceId: string }) => void) | undefined;
    backupApi.me.mockImplementation((options: { context: { spaceId: string } }) => {
      const requestedSpaceId = options.context.spaceId;
      if (requestedSpaceId === "space-a" && backupApi.me.mock.calls.length === 2) {
        return new Promise((resolve) => {
          resolveOldSpaceMe = resolve;
        });
      }
      return Promise.resolve({
        userId: requestedSpaceId === "space-a" ? "user-a" : "user-b",
        spaceId: requestedSpaceId,
      });
    });
    backupApi.backups.mockImplementation(
      (_input: unknown, options: { context: { spaceId: string } }) =>
        Promise.resolve(
          options.context.spaceId === "space-a"
            ? []
            : [{ provider: "openai", modelId: "gpt-test" }],
        ),
    );
    await renderSettings();
    await addBackup("Claude Sonnet");

    backupApi.selectedSpaceId.mockReturnValue("space-b");
    await renderSettings({ userId: "user-b", spaceId: "space-b" });
    resolveOldSpaceMe?.({ userId: "user-a", spaceId: "space-a" });
    await flush();

    expect(backupRows()).toEqual(["OpenAI · GPT test"]);
    expect(backupApi.setBackups).toHaveBeenCalledTimes(1);
    expect(backupApi.setBackups.mock.calls[0]?.[1]).toEqual({ context: { spaceId: "space-a" } });
  });

  it("refuses to save when the session now belongs to another space", async () => {
    backupApi.me
      .mockResolvedValueOnce({ userId: scope.userId, spaceId: scope.spaceId })
      .mockResolvedValueOnce({ userId: scope.userId, spaceId: "space-b" });
    await renderSettings();
    await addBackup("Claude Sonnet");
    await flush();

    expect(backupApi.setBackups).not.toHaveBeenCalled();
    expect(backupRows()).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Space changed. Reopen Models to save its backup list.",
    );
  });
});

it("names subscription connections by their plan in backup rows", async () => {
  backupApi.backups.mockResolvedValue([
    { provider: "openai-codex", modelId: "gpt-sol" },
    { provider: "anthropic", modelId: "claude-sonnet" },
  ]);
  await renderSettings({
    catalog: [
      ...catalog,
      {
        provider: "openai-codex",
        providerName: "OpenAI Codex",
        id: "gpt-sol",
        label: "GPT Sol",
        billing: "",
      },
    ],
    credentials: [
      { ...credentials[0]!, authKind: "oauth" },
      {
        id: "codex-credential",
        provider: "openai-codex",
        label: "OpenAI Codex",
        hasKey: false,
        isDefault: false,
        authKind: "oauth",
      },
    ],
  });
  expect(backupRows()).toEqual([
    "ChatGPT subscription · GPT Sol",
    "Claude subscription · Claude Sonnet",
  ]);
});
