// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { AgentImportPlan } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const importPreview = vi.fn();
vi.mock("../../lib/rpc", () => ({
  rpc: { bots: { importPreview: (input: unknown) => importPreview(input) } },
}));

import { AgentImportForm } from "./agent-import";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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
      root!.render(
        <AgentImportForm
          onBack={() => undefined}
          onCancel={() => undefined}
          onCreated={() => undefined}
        />,
      );
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
      root!.render(
        <AgentImportForm
          onBack={() => undefined}
          onCancel={() => undefined}
          onCreated={() => undefined}
        />,
      );
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

describe("choosing another agent while the first is still being read", () => {
  it("shows only the latest choice", async () => {
    let finishFirst: (value: AgentImportPlan) => void = () => undefined;
    importPreview
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ ...plan, suggestedName: "Second" });
    const source = (soul: string) => ({
      paths: [".openclaw/workspace/SOUL.md"],
      read: () => soul,
      size: () => soul.length,
    });
    const form = (initialSource: ReturnType<typeof source>) => (
      <AgentImportForm
        onBack={() => undefined}
        onCancel={() => undefined}
        onCreated={() => undefined}
        initialSource={initialSource}
      />
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(form(source("First."))));
    await act(async () => root!.render(form(source("Second."))));
    await act(async () => finishFirst({ ...plan, suggestedName: "First" }));

    const names = [...container.querySelectorAll("input")].map((input) => input.value);
    expect(names).toContain("Second");
    expect(names).not.toContain("First");
  });
});
