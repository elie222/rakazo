// @vitest-environment jsdom

import type { Bot, Routine } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/query/rpc";
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
  inChat: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
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
let finishUpdate: Deferred<Routine>;
const update = vi.fn();
const rotateWebhookSecret = vi.fn();
const testRun = vi.fn();
const openGroup = vi.fn();
const refreshThread = vi.fn(async () => ({}) as never);
let activeBot: Bot;
const activeBotId = { current: "" };

function Harness() {
  editor = useRoutineEditor({
    rpc: { routines: { update, testRun }, bots: { rotateWebhookSecret } } as unknown as ReturnType<
      typeof createSpaceRpc
    >,
    active: activeBot,
    activeBotId,
    timezone: "UTC",
    messageProviders: [],
    setBots: () => {},
    refreshThread,
    openGroup,
    setPanel: () => {},
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeBot = { id: "bot-1", webhookConfigured: false } as Bot;
  activeBotId.current = activeBot.id;
  update.mockImplementation(() => {
    finishUpdate = deferred();
    return finishUpdate.promise;
  });
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
    finishUpdate.resolve({ ...routine, name: "Weekly", prompt: "Check in." });
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

it("sends Use my computer only when the owner flips it", async () => {
  const own = { ...routine, prompt: "Check the backups", useComputer: false };
  update.mockResolvedValue(own);
  act(() => editor.editRoutine(own));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("useComputer");

  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, useComputer: true }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ useComputer: true });
});

it("approves again the prompt shown when a save edits it while Use my computer is on", async () => {
  const own = { ...routine, prompt: "Check the backups", useComputer: true };
  update.mockResolvedValue(own);
  act(() => editor.editRoutine(own));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: !own.active }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("useComputer");

  act(() => editor.editRoutine(own));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, prompt: "Twice" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ useComputer: true, prompt: "Twice" });
});

it("never sends Use my computer for a routine that doesn't offer it", async () => {
  update.mockResolvedValue(routine);
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, useComputer: true }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("useComputer");
});

it("shows a revealed webhook secret only for the bot it belongs to", async () => {
  let finishRotate!: Deferred<{ secret: string }>;
  rotateWebhookSecret.mockImplementation(() => {
    finishRotate = deferred();
    return finishRotate.promise;
  });
  let ensuring!: Promise<void>;
  act(() => {
    ensuring = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });

  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  await act(async () => {
    finishRotate.resolve({ secret: "secret-1" });
    await ensuring;
  });
  expect(editor.editorProps!.webhook.secret).toBeNull();
  expect(editor.editorProps!.webhook.configured).toBe(false);

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

it("keeps each bot's revealed secret when rotations overlap", async () => {
  const finishers: ((result: { secret: string }) => void)[] = [];
  rotateWebhookSecret.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
  let first!: Promise<void>;
  act(() => {
    first = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  let second!: Promise<void>;
  act(() => {
    second = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  await act(async () => {
    finishers[0]!({ secret: "secret-1" });
    finishers[1]!({ secret: "secret-2" });
    await Promise.all([first, second]);
  });
  expect(editor.editorProps!.webhook.secret).toBe("secret-2");

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

it("shows why a key cannot be set instead of leaving the rejection unhandled", async () => {
  rotateWebhookSecret.mockRejectedValue(
    Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 }),
  );
  await act(async () => {
    await editor.editorProps!.onEnsureWebhook();
  });
  expect(editor.editorProps!.error).toBe("Only the bot's creator can set its webhook key.");
});

it("drops a key failure that arrives after switching to another bot", async () => {
  let fail!: Deferred<{ secret: string }>;
  rotateWebhookSecret.mockImplementation(() => {
    fail = deferred();
    return fail.promise;
  });
  let ensuring!: Promise<void>;
  act(() => {
    ensuring = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  activeBotId.current = "bot-2";
  await act(async () => {
    fail.reject(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
    await ensuring;
  });
  expect(editor.editorProps!.error).toBeNull();
});

it("opens the group a group routine's Run now went to", async () => {
  testRun.mockResolvedValue({ runId: "run-1", groupId: "group-1" });
  act(() => editor.editRoutine(routine));
  await act(async () => {
    await editor.editorProps!.onTestRun();
  });
  expect(testRun).toHaveBeenCalledWith({ routineId: "routine-1" });
  expect(openGroup).toHaveBeenCalledWith("group-1");
  expect(refreshThread).not.toHaveBeenCalled();
});

it("stays put when they moved to another chat before the run was accepted", async () => {
  testRun.mockResolvedValue({ runId: "run-1", groupId: "group-1" });
  act(() => editor.editRoutine(routine));
  activeBotId.current = "bot-2";
  await act(async () => {
    await editor.editorProps!.onTestRun();
  });
  expect(openGroup).not.toHaveBeenCalled();
});

it("refreshes the bot's chat when Run now ran there", async () => {
  testRun.mockResolvedValue({ runId: "run-1", groupId: null });
  act(() => editor.editRoutine(routine));
  await act(async () => {
    await editor.editorProps!.onTestRun();
  });
  expect(refreshThread).toHaveBeenCalledWith("bot-1");
  expect(openGroup).not.toHaveBeenCalled();
});
