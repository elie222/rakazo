// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useRoutineEditor } from "./use-routine-editor";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily",
  prompt: "",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

let root: Root;
let editor: ReturnType<typeof useRoutineEditor>;
let finishUpdate: (saved: Routine) => void;
const update = vi.fn();

function Harness() {
  editor = useRoutineEditor({
    rpc: { routines: { update } } as unknown as ReturnType<typeof createSpaceRpc>,
    active: { id: "bot-1", webhookConfigured: false } as Bot,
    activeBotId: { current: "bot-1" },
    timezone: "UTC",
    messageProviders: [],
    setBots: () => {},
    refreshThread: async () => ({}) as never,
    setPanel: () => {},
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockImplementation(() => new Promise<Routine>((resolve) => (finishUpdate = resolve)));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps edits made while a save is in flight", async () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Weekly" }));

  let saving!: Promise<void>;
  act(() => {
    saving = editor.editorProps!.onSave() as unknown as Promise<void>;
  });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Weekly" }));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Monthly" }));

  await act(async () => {
    finishUpdate({ ...routine, name: "Weekly", prompt: "Check in." });
    await saving;
  });

  expect(editor.editingRoutine?.name).toBe("Weekly");
  expect(editor.editorProps!.draft.name).toBe("Monthly");
  expect(editor.editorProps!.draft.prompt).toBe("Check in.");
});

it("sends on/off only when the save changes it", async () => {
  update.mockResolvedValue(routine);
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("active");

  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: false }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ active: false });
});
