// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MemoryNoteScreen from "../app/(settings)/memory-note";

type AlertButton = { text: string; style?: string; onPress?: () => void };

const mocks = vi.hoisted(() => ({
  params: {} as { id?: string; botId?: string },
  options: {} as { title?: string; headerRight?: () => ReactNode },
  back: vi.fn(),
  dispatch: vi.fn(),
  rpc: vi.fn(),
  alert: vi.fn(),
  preventRemove: { active: false, onRemove: null as null | ((event: unknown) => void) },
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ primary: "#000", destructive: "#f00" }) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ back: mocks.back }),
  useNavigation: () => ({
    dispatch: mocks.dispatch,
    setOptions: (next: typeof mocks.options) => Object.assign(mocks.options, next),
  }),
}));
vi.mock("expo-router/react-navigation", () => ({
  usePreventRemove: (active: boolean, onRemove: (event: unknown) => void) => {
    mocks.preventRemove.active = active;
    mocks.preventRemove.onRemove = onRemove;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    ActivityIndicator: () => <span role="status" />,
    TextInput: ({
      value,
      onChangeText,
      editable,
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      editable?: boolean;
      accessibilityLabel?: string;
    }) => (
      <textarea
        aria-label={accessibilityLabel}
        value={value}
        readOnly={editable === false}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
    Alert: { alert: mocks.alert },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

const note = {
  id: "note-1",
  scope: "bot",
  botId: "bot-1",
  path: "preferences.md",
  content: "Prefers short replies.\n",
  revision: 3,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.params = { id: note.id, botId: note.botId };
  mocks.options = {};
  mocks.preventRemove.active = false;
  mocks.preventRemove.onRemove = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(<MemoryNoteScreen />));
  await act(async () => undefined);
}
function editor() {
  return container.querySelector("textarea") as HTMLTextAreaElement | null;
}
async function type(text: string) {
  const input = editor();
  if (!input) throw new Error("Missing editor");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function headerSave() {
  const holder = document.createElement("div");
  const header = createRoot(holder);
  act(() => header.render(mocks.options.headerRight?.()));
  const save = holder.querySelector("button") as HTMLButtonElement;
  if (!save.disabled) await act(async () => save.click());
  act(() => header.unmount());
  return save;
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
}
function lastAlert() {
  const [title, , buttons] = mocks.alert.mock.calls.at(-1) as [string, undefined, AlertButton[]];
  return { title, press: (text: string) => buttons.find((b) => b.text === text)?.onPress?.() };
}

it("edits a bot's note against the revision it opened, then goes back", async () => {
  mocks.rpc.mockImplementation(async (proc: string, body: Record<string, unknown>) => {
    if (proc === "memory/list") return [note];
    if (proc === "memory/update") return { ...note, content: body.content, revision: 4 };
    throw new Error(`Unexpected ${proc}`);
  });
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("memory/list", { botId: "bot-1", scope: "bot" });
  expect(mocks.options.title).toBe("preferences.md");
  expect(editor()?.value).toBe(note.content);
  expect((await headerSave()).disabled).toBe(true);
  expect(mocks.preventRemove.active).toBe(false);

  await type("Prefers bullet points.\n");
  expect(mocks.preventRemove.active).toBe(true);
  await headerSave();
  expect(mocks.rpc).toHaveBeenCalledWith("memory/update", {
    documentId: note.id,
    content: "Prefers bullet points.\n",
    expectedRevision: 3,
  });
  expect(mocks.preventRemove.active).toBe(false);
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("keeps the edit and stays open when saving fails", async () => {
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return [note];
    throw new Error("Request failed");
  });
  await render();
  await type("Unsaved thought\n");
  await headerSave();
  expect(editor()?.value).toBe("Unsaved thought\n");
  expect(container.textContent).toContain("Request failed");
  expect(mocks.back).not.toHaveBeenCalled();
  expect(mocks.preventRemove.active).toBe(true);
});

it("asks before leaving with unsaved changes", async () => {
  mocks.rpc.mockResolvedValue([note]);
  await render();
  await type("Draft\n");
  const action = { type: "GO_BACK" };
  act(() => mocks.preventRemove.onRemove?.({ data: { action } }));
  expect(lastAlert().title).toBe("Discard changes?");
  expect(mocks.dispatch).not.toHaveBeenCalled();
  lastAlert().press("Discard");
  expect(mocks.dispatch).toHaveBeenCalledWith(action);
});

it("offers the latest version or the edit when the note changed elsewhere", async () => {
  const latest = { ...note, content: "Bot rewrote this.\n", revision: 5 };
  let lists = 0;
  mocks.rpc.mockImplementation(async (proc: string, body: Record<string, unknown>) => {
    if (proc === "memory/list") return lists++ === 0 ? [note] : [latest];
    if (proc === "memory/update") {
      if (body.expectedRevision === 3)
        throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
      return { ...latest, content: body.content, revision: 6 };
    }
    throw new Error(`Unexpected ${proc}`);
  });
  await render();
  await type("My edit\n");
  await headerSave();
  expect(lastAlert().title).toBe("This note changed");
  expect(editor()?.value).toBe("My edit\n");
  expect(mocks.back).not.toHaveBeenCalled();

  await act(async () => lastAlert().press("Save mine"));
  expect(mocks.rpc).toHaveBeenLastCalledWith("memory/update", {
    documentId: note.id,
    content: "My edit\n",
    expectedRevision: 5,
  });
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("can replace the edit with the latest version after a conflict", async () => {
  const latest = { ...note, content: "Bot rewrote this.\n", revision: 5 };
  let lists = 0;
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return lists++ === 0 ? [note] : [latest];
    throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
  });
  await render();
  await type("My edit\n");
  await headerSave();
  await act(async () => lastAlert().press("Use latest"));
  expect(editor()?.value).toBe(latest.content);
  expect(mocks.preventRemove.active).toBe(false);
});

it("deletes a note only after a destructive confirm", async () => {
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return [note];
    if (proc === "memory/remove") return { ok: true };
    throw new Error(`Unexpected ${proc}`);
  });
  await render();
  await act(async () => button("Delete")?.click());
  expect(mocks.rpc).not.toHaveBeenCalledWith("memory/remove", expect.anything());
  expect(lastAlert().title).toBe("Delete preferences.md?");
  await act(async () => lastAlert().press("Delete"));
  expect(mocks.rpc).toHaveBeenCalledWith("memory/remove", { documentId: note.id });
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("keeps the note open when deleting fails", async () => {
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return [note];
    throw new Error("Request failed");
  });
  await render();
  await act(async () => button("Delete")?.click());
  await act(async () => lastAlert().press("Delete"));
  expect(container.textContent).toContain("Request failed");
  expect(mocks.back).not.toHaveBeenCalled();
  expect(button("Delete")?.disabled).toBe(false);
});

it("opens a shared note from the space's notes and never offers to delete MEMORY.md", async () => {
  mocks.params = { id: "index-1" };
  mocks.rpc.mockResolvedValue([
    { ...note, id: "index-1", scope: "user", botId: null, path: "MEMORY.md" },
  ]);
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("memory/list", { scope: "user" });
  expect(mocks.options.title).toBe("MEMORY.md");
  expect(editor()).not.toBeNull();
  expect(button("Delete")).toBeUndefined();
});

it("says when the note is gone and retries a failed load", async () => {
  mocks.rpc.mockResolvedValueOnce([]);
  await render();
  expect(container.textContent).toContain("This note no longer exists");
  expect(editor()).toBeNull();
  expect(mocks.options.headerRight).toBeUndefined();

  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([note]);
  await render();
  expect(editor()).toBeNull();
  await act(async () => button("Retry")?.click());
  expect(editor()?.value).toBe(note.content);
});

it.each([
  ["the save finds it gone", Object.assign(new Error("gone"), { code: "NOT_FOUND" }), [note]],
  [
    "the conflict reload finds it gone",
    Object.assign(new Error("conflict"), { code: "CONFLICT" }),
    [],
  ],
])("shows a note deleted elsewhere read-only when %s", async (_case, failure, reloaded) => {
  let lists = 0;
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return lists++ === 0 ? [note] : reloaded;
    throw failure;
  });
  await render();
  await type("Draft to keep\n");
  await headerSave();
  expect(container.textContent).toContain("This note no longer exists");
  expect(editor()?.value).toBe("Draft to keep\n");
  expect(editor()?.readOnly).toBe(true);
  expect(mocks.options.headerRight).toBeUndefined();
  expect(button("Delete")).toBeUndefined();
  expect(mocks.alert).not.toHaveBeenCalled();
  // Leaving still asks before the draft on screen is lost.
  expect(mocks.preventRemove.active).toBe(true);
  act(() => mocks.preventRemove.onRemove?.({ data: { action: { type: "GO_BACK" } } }));
  expect(lastAlert().title).toBe("Discard changes?");
});

it("treats deleting a note already deleted elsewhere as done", async () => {
  mocks.rpc.mockImplementation(async (proc: string) => {
    if (proc === "memory/list") return [note];
    throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
  });
  await render();
  await act(async () => button("Delete")?.click());
  await act(async () => lastAlert().press("Delete"));
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("does not offer to discard an edit while its save is in flight", async () => {
  let finishSave!: (doc: typeof note) => void;
  mocks.rpc.mockImplementation((proc: string) => {
    if (proc === "memory/list") return Promise.resolve([note]);
    return new Promise((resolve) => (finishSave = resolve));
  });
  await render();
  await type("Saving this\n");
  await headerSave();
  act(() => mocks.preventRemove.onRemove?.({ data: { action: { type: "GO_BACK" } } }));
  expect(mocks.alert).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await act(async () => finishSave({ ...note, content: "Saving this\n", revision: 4 }));
  expect(mocks.back).toHaveBeenCalledTimes(1);
});

it("loads the new note when the screen is reused for another one", async () => {
  const other = { ...note, id: "note-2", path: "sources.md", content: "Cite primary sources.\n" };
  mocks.rpc.mockResolvedValue([note, other]);
  await render();
  expect(editor()?.value).toBe(note.content);
  mocks.params = { id: other.id, botId: note.botId };
  await render();
  expect(editor()?.value).toBe(other.content);
  expect(mocks.options.title).toBe("sources.md");
});
