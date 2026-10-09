// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({
  rpc: {
    voice: { voices: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    me: vi.fn(async () => ({})),
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
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
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
    pressed: _pressed,
    onPressedChange: _onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    variant?: string;
  }) => <button type="button" {...props} />,
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));

import { BotSettings } from "./bot-panel";

const bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "Helper",
  description: "Helps",
  instructions: "Helps",
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
  computerMode: "dedicated",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: ["remember"],
  webhookConfigured: false,
  spawnKey: null,
} as Bot;

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

type SavePatch = { disabledBuiltinTools?: string[] };

function setField(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitToolName(input: HTMLInputElement, value: string) {
  await act(async () => {
    setField(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
}

async function renderSettings(onSave: (patch: SavePatch) => Promise<void>, currentBot = bot) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={currentBot}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
  await flush();
}

describe("BotSettings disabled tools", () => {
  it("omits the disabled-tool list from an unrelated save", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    if (!save) throw new Error("Missing save button");
    await act(async () => {
      save.click();
    });
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("disabledBuiltinTools");
  });

  it("sends the disabled-tool list when that list changes", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);

    const toggle = container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]');
    if (!toggle) throw new Error("Missing tool toggle");
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ disabledBuiltinTools: [] }));
  });

  it("uses a refreshed server list for the next addition and removal", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["web_fetch"] });
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    expect(onSave.mock.calls[0]?.[0].disabledBuiltinTools).toEqual(["web_fetch", "web_search"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-web_fetch"]')!.click();
    });
    expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["web_search"]);
  });

  it.each([false, true])(
    "rebases a refresh during an in-flight save (reject: %s)",
    async (reject) => {
      let release: (() => void) | undefined;
      const onSave = vi
        .fn<(patch: SavePatch) => Promise<void>>()
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (reject) throw new Error("Network failed");
        })
        .mockResolvedValue(undefined);
      await renderSettings(onSave);
      const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]')!;
      await submitToolName(input, "web_search");
      await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["web_fetch"] });
      await act(async () => {
        release?.();
      });
      await flush();
      expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
      expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
      if (reject) {
        expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();
        await submitToolName(input, "web_search");
      }
      expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["web_fetch", "web_search"]);
      expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    },
  );

  it("rebases queued edits and a removal on a refresh during a save", async () => {
    let release: (() => void) | undefined;
    const onSave = vi
      .fn<(patch: SavePatch) => Promise<void>>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValue(undefined);
    await renderSettings(onSave);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["remember", "web_fetch"] });
    await act(async () => {
      release?.();
    });
    await flush();
    expect(onSave.mock.calls.map(([patch]) => patch.disabledBuiltinTools)).toEqual([
      [],
      ["web_fetch"],
      ["web_fetch", "web_search"],
    ]);
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
  });

  it("reconciles a fresh server list even when it matches the opening value", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]')!.click();
    });
    expect(container.querySelector('[id$="-disabled-remember"]')).toBeNull();
    await renderSettings(onSave, { ...bot, disabledBuiltinTools: ["remember"] });
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]')!;
    await submitToolName(input, "web_search");
    expect(onSave.mock.calls[1]?.[0].disabledBuiltinTools).toEqual(["remember", "web_search"]);
  });

  it("drops a failed disable so the same name can be saved again", async () => {
    let fail = true;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => {
      if (fail) throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");

    expect(container.textContent).toContain("Network failed");
    expect(container.textContent).toContain("remember");
    expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();

    fail = false;
    await submitToolName(input, "web_search");

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ disabledBuiltinTools: ["remember", "web_search"] }),
    );
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Network failed");
  });

  it("restores a tool when turning it back on fails", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => {
      throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const toggle = container.querySelector<HTMLButtonElement>('[id$="-disabled-remember"]');
    if (!toggle) throw new Error("Missing tool toggle");
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(container.textContent).toContain("Network failed");
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ disabledBuiltinTools: [] }));
  });

  it("keeps a newer disable when an earlier save fails", async () => {
    let releaseFirst: (() => void) | undefined;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async (patch) => {
      const tools = patch.disabledBuiltinTools ?? [];
      if (tools.includes("web_search") && !tools.includes("web_fetch")) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error("Network failed");
      }
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");
    expect(releaseFirst).toBeTypeOf("function");
    await submitToolName(input, "web_fetch");

    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();

    await act(async () => {
      releaseFirst?.();
    });
    await flush();
    await flush();

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        disabledBuiltinTools: ["remember", "web_search", "web_fetch"],
      }),
    );
    expect(container.querySelector('[id$="-disabled-web_search"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Network failed");
  });

  it("returns to the last saved list when a later disable also fails", async () => {
    let releaseFirst: (() => void) | undefined;
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async (patch) => {
      const tools = patch.disabledBuiltinTools ?? [];
      if (tools.includes("web_search") && !tools.includes("web_fetch")) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");
    await submitToolName(input, "web_search");
    await submitToolName(input, "web_fetch");
    await act(async () => {
      releaseFirst?.();
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Network failed");
    expect(container.querySelector('[id$="-disabled-remember"]')).not.toBeNull();
    expect(container.querySelector('[id$="-disabled-web_search"]')).toBeNull();
    expect(container.querySelector('[id$="-disabled-web_fetch"]')).toBeNull();
  });

  it("clears an unknown-tool error while the name is edited and keeps other errors", async () => {
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => {
      throw new Error("Network failed");
    });
    await renderSettings(onSave);

    const input = container.querySelector<HTMLInputElement>('[id$="-disabled-tools"]');
    if (!input) throw new Error("Missing tool field");

    await act(async () => {
      setField(input, "not_a_tool");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("Unknown tool");

    await act(async () => {
      setField(input, "web");
    });
    await flush();
    expect(container.textContent).not.toContain("Unknown tool");

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    if (!save) throw new Error("Missing save button");
    await act(async () => {
      save.click();
    });
    await flush();
    expect(container.textContent).toContain("Network failed");

    await act(async () => {
      setField(input, "web_search");
    });
    await flush();
    expect(container.textContent).toContain("Network failed");
    expect(container.textContent).not.toContain("Unknown tool");
  });
});
