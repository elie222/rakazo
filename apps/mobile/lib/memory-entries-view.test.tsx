// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(() => (text: string) => text);
vi.mock("./api", () => ({ rpc }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: () => "Error" }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: translate }) }));
vi.mock("react-native", () => {
  const wrap = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Alert: { alert: vi.fn() }, Modal: wrap, ScrollView: wrap, Text: wrap, View: wrap };
});

it("shows prompt memory even when the bot has no local entries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.mockResolvedValue({ text: "shared fact", usedBytes: 11, limitBytes: 32768 });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryEntries
          initial={null}
          botId="bot"
          onClose={() => {}}
          onUpdate={() => {}}
          onRefresh={async () => {}}
        />,
      ),
    );
    expect(rpc).toHaveBeenCalledWith("memory/prompt", { botId: "bot" });
    expect(container.textContent).toContain("shared fact");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/profile-edit-dialog", () => ({
  ProfileEditDialog: ({ value, onCommit }: { value: string; onCommit: (next: string) => void }) => (
    <button type="button" onClick={() => onCommit("corrected")}>
      {value}
    </button>
  ),
}));

import { MemoryEntries } from "../components/memory-entries";

it("edits one occurrence and undoes only its saved revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const initial = {
    id: "doc",
    scope: "bot" as const,
    botId: "bot",
    path: "MEMORY.md",
    content: "same\nsame",
    revision: 1,
    updatedAt: "",
  };
  rpc.mockImplementation(async (method: string) =>
    method === "memory/editEntry"
      ? { ...initial, content: "same\ncorrected", revision: 2 }
      : { ...initial, revision: 3 },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryEntries
          initial={initial}
          botId="bot"
          onClose={() => {}}
          onUpdate={() => {}}
          onRefresh={async () => {}}
        />,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .filter((button) => button.textContent === "same")[1]!
        .click(),
    );
    expect(rpc).toHaveBeenCalledWith("memory/editEntry", {
      documentId: "doc",
      expectedRevision: 1,
      start: 5,
      end: 9,
      expected: "same",
      replacement: "corrected",
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Undo")!
        .click(),
    );
    expect(rpc).toHaveBeenCalledWith("memory/undoEntry", {
      documentId: "doc",
      expectedRevision: 2,
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
