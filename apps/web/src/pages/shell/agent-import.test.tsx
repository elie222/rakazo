// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { AgentImportPlan, Bot } from "@rakazo/contracts";
import type * as Core from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DOCUMENT_MAX_BYTES } from "../../lib/agent-document";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const importPreview = vi.fn();
const importCreate = vi.fn();
vi.mock("../../lib/rpc", () => ({
  rpc: {
    bots: {
      importPreview: (input: unknown) => importPreview(input),
      importCreate: (input: unknown) => importCreate(input),
    },
  },
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  openAgentImportArchive: (bytes: Uint8Array) => {
    const content = bytes[0] === 1 ? "First" : "Second";
    return {
      paths: [".openclaw/workspace/SOUL.md"],
      read: () => content,
      size: () => content.length,
    };
  },
}));

import { AgentImportForm } from "./agent-import";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  importPreview.mockReset();
  importCreate.mockReset();
  i18n.load("en", {});
  i18n.activate("en");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("choosing backups while a file is being read", () => {
  function deferred() {
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ArrayBuffer>((success, failure) => {
      resolve = success;
      reject = failure;
    });
    return { promise, resolve, reject };
  }

  function backup(read: Promise<ArrayBuffer>) {
    const file = new File(["backup"], "backup.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", { value: () => read });
    return file;
  }

  async function render() {
    importPreview.mockImplementation(async ({ files }: { files: { content: string }[] }) => ({
      ...plan,
      suggestedName: files[0]?.content,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentImportForm onClose={() => undefined} onCreated={() => undefined} />);
    });
    return container.querySelector<HTMLInputElement>('[data-testid="agent-import-archive"]')!;
  }

  async function select(input: HTMLInputElement, file?: File) {
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: file ? [file] : [] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function names() {
    return [...container!.querySelectorAll("input")].map((input) => input.value);
  }

  it("keeps the newer preview when an older backup finishes later", async () => {
    const first = deferred();
    const second = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    await select(input, backup(second.promise));
    await act(async () => second.resolve(new Uint8Array([2]).buffer));
    expect(names()).toContain("Second");

    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(names()).toContain("Second");
    expect(names()).not.toContain("First");
    expect(importPreview).toHaveBeenCalledTimes(1);
  });

  it("does not show a late failure over the newer preview", async () => {
    const first = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    await select(input, backup(Promise.resolve(new Uint8Array([2]).buffer)));
    expect(names()).toContain("Second");

    await act(async () => first.reject(new Error("read failed")));
    expect(names()).toContain("Second");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a document selected while an older backup is still reading", async () => {
    const first = deferred();
    const archive = await render();
    await select(archive, backup(first.promise));
    const documentInput = container!.querySelector<HTMLInputElement>(
      '[data-testid="agent-import-document"]',
    )!;
    const documentFile = new File(["Document"], "agent.md", { type: "text/markdown" });
    Object.defineProperty(documentFile, "text", { value: async () => "Document" });
    await select(documentInput, documentFile);
    expect(names()).toContain("Document");

    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(names()).toContain("Document");
    expect(names()).not.toContain("First");
    expect(importPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps a backup selected while an older document is still reading", async () => {
    let finishDocument!: (value: string) => void;
    const documentRead = new Promise<string>((resolve) => {
      finishDocument = resolve;
    });
    const archive = await render();
    const documentInput = container!.querySelector<HTMLInputElement>(
      '[data-testid="agent-import-document"]',
    )!;
    const documentFile = new File(["Document"], "agent.md", { type: "text/markdown" });
    Object.defineProperty(documentFile, "text", { value: () => documentRead });
    await select(documentInput, documentFile);
    await select(archive, backup(Promise.resolve(new Uint8Array([2]).buffer)));
    expect(names()).toContain("Second");

    await act(async () => finishDocument("Document"));
    expect(names()).toContain("Second");
    expect(names()).not.toContain("Document");
    expect(importPreview).toHaveBeenCalledTimes(1);
  });

  it("reports an oversized document and releases busy state while an older preview is pending", async () => {
    let finishPreview!: (value: AgentImportPlan) => void;
    const archive = await render();
    importPreview.mockReturnValueOnce(
      new Promise<AgentImportPlan>((resolve) => {
        finishPreview = resolve;
      }),
    );
    await select(archive, backup(Promise.resolve(new Uint8Array([1]).buffer)));
    const chooseBackup = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose backup",
    )!;
    expect(chooseBackup.disabled).toBe(true);

    const documentInput = container!.querySelector<HTMLInputElement>(
      '[data-testid="agent-import-document"]',
    )!;
    const documentFile = new File([], "large.md", { type: "text/markdown" });
    Object.defineProperty(documentFile, "size", { value: AGENT_DOCUMENT_MAX_BYTES + 1 });
    await select(documentInput, documentFile);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "These files are too large to import.",
    );
    expect(chooseBackup.disabled).toBe(false);

    await act(async () => finishPreview({ ...plan, suggestedName: "First" }));
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "These files are too large to import.",
    );
    expect(container!.querySelector('[data-testid="agent-import-choose"]')).not.toBeNull();
    expect(chooseBackup.disabled).toBe(false);
  });

  it("discards a pending backup when the native file picker is cancelled", async () => {
    const first = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    await act(async () => {
      input.dispatchEvent(new Event("cancel", { bubbles: true }));
    });
    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(importPreview).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="agent-import-choose"]')).not.toBeNull();
  });

  it("discards a pending backup when the selection is cleared", async () => {
    const first = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    await select(input);
    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(importPreview).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="agent-import-choose"]')).not.toBeNull();
  });

  it.each(["Back", "Cancel new bot"])("discards a pending backup on %s", async (label) => {
    const first = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    const button = container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    await act(async () => button.click());
    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(importPreview).not.toHaveBeenCalled();
  });

  it("discards a pending backup on unmount", async () => {
    const first = deferred();
    const input = await render();
    await select(input, backup(first.promise));
    await act(async () => root!.unmount());
    root = null;
    await act(async () => first.resolve(new Uint8Array([1]).buffer));
    expect(importPreview).not.toHaveBeenCalled();
  });

  it("shows the current backup read failure", async () => {
    const current = deferred();
    const input = await render();
    await select(input, backup(current.promise));
    await act(async () => current.reject(new Error("read failed")));
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not read these files",
    );
    expect(importPreview).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** What the server returns for a document with a pasted key in its memory. */
const plan: AgentImportPlan = {
  source: "document",
  suggestedName: "Pebble",
  suggestedDescription: "",
  instructions: [
    {
      id: "instructions:Instructions",
      title: "Instructions",
      content: "Be brief.",
      role: "working",
      stock: false,
      mentions: [],
    },
  ],
  memory: [
    {
      id: "memory:notes",
      title: "notes",
      content: "My key is in here.",
      path: "notes.md",
      spacePath: "notes.md",
      stock: false,
      containsKey: true,
    },
  ],
  skills: [],
  model: null,
  mcpServers: [],
  routines: [],
  apiKeys: [],
  skipped: [],
};

describe("an item whose text looks like it contains a key", () => {
  it("starts unticked, says so, and can still be ticked", async () => {
    importPreview.mockResolvedValue(plan);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentImportForm onClose={() => undefined} onCreated={() => undefined} />);
    });
    const reply = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Paste the reply"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        reply,
        "# Instructions\nBe brief.\n",
      );
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue",
    )!;
    await act(async () => continueButton.click());

    const box = (label: string) =>
      container!.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`)!;
    const memory = container.querySelector('[data-testid="agent-import-memory"]')!;
    expect(memory.textContent).toContain("Looks like it contains a key");
    expect(box("notes").getAttribute("aria-checked")).toBe("false");
    // Everything else keeps its usual default.
    expect(box("Instructions").getAttribute("aria-checked")).toBe("true");

    await act(async () => box("notes").click());
    expect(box("notes").getAttribute("aria-checked")).toBe("true");
  });

  it("never shows a key as a title: a key-looking heading or skill name gets a plain label", async () => {
    // Synthetic, built from parts so no scanner mistakes it for a leak.
    const key = ["sk", "-proj-", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA12345678"].join("");
    importPreview.mockResolvedValue({
      ...plan,
      memory: [{ ...plan.memory[0]!, title: key, content: `## ${key}\nNotes.` }],
      skills: [
        {
          id: "skill:deploy",
          title: key,
          name: key,
          description: `Uses ${key}`,
          content: `---\nname: ${key}\n---\nShip it.\n`,
          warnings: [],
          status: { kind: "ready" },
          containsKey: true,
        },
      ],
    } satisfies AgentImportPlan);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentImportForm onClose={() => undefined} onCreated={() => undefined} />);
    });
    const reply = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Paste the reply"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        reply,
        "# Instructions\nBe brief.\n",
      );
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      [...container!.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click(),
    );
    const labels = [...container.querySelectorAll("[aria-label]")].map((element) =>
      element.getAttribute("aria-label"),
    );
    expect(labels).toEqual(expect.arrayContaining(["Memory 1", "Skill 1", "Memory for Memory 1"]));
    const memory = container.querySelector('[data-testid="agent-import-memory"]')!;
    const skills = container.querySelector('[data-testid="agent-import-skills"]')!;
    for (const section of [memory, skills]) {
      const summary = section.querySelector("ul > li > div > div")!;
      expect(summary.textContent).not.toContain(key);
    }
    expect(labels.join("\n")).not.toContain(key);
  });
});

describe("creating a bot", () => {
  function button(label: string) {
    return [...container!.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    ) as HTMLButtonElement;
  }

  async function openPreview() {
    importPreview.mockResolvedValue(plan);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentImportForm onClose={onClose} onCreated={onCreated} />);
    });
    const archive = container.querySelector<HTMLInputElement>(
      '[data-testid="agent-import-archive"]',
    )!;
    const file = new File(["backup"], "backup.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.resolve(new Uint8Array([2]).buffer),
    });
    await act(async () => {
      Object.defineProperty(archive, "files", { configurable: true, value: [file] });
      archive.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return { onClose, onCreated };
  }

  it("keeps the preview when Back is pressed while creation is running", async () => {
    let finish!: (bot: Bot) => void;
    importCreate.mockReturnValue(new Promise<Bot>((resolve) => (finish = resolve)));
    const { onClose, onCreated } = await openPreview();
    await act(async () => button("Create").click());
    expect(button("Back").disabled).toBe(true);

    await act(async () => button("Back").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="agent-import-preview"]')).not.toBeNull();
    expect(button("Creating…").disabled).toBe(true);

    await act(async () => finish({ id: "bot-1" } as Bot));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(importCreate).toHaveBeenCalledTimes(1);
  });

  it("lets Back leave the preview after creation fails", async () => {
    importCreate.mockRejectedValue(new Error("nope"));
    const { onClose } = await openPreview();
    await act(async () => button("Create").click());
    await act(async () => button("Back").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="agent-import-preview"]')).toBeNull();
  });
});
