// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SkillScreen from "../app/(settings)/skill";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({
  params: {} as { id?: string },
  options: {} as { title?: string; headerRight?: () => ReactNode },
  back: vi.fn(),
  rpc: vi.fn(),
  alert: vi.fn(),
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
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ back: mocks.back }),
  useNavigation: () => ({
    setOptions: (next: typeof mocks.options) => Object.assign(mocks.options, next),
  }),
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
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    ActivityIndicator: () => <span role="status" />,
    TextInput: ({
      value,
      onChangeText,
      editable,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      editable?: boolean;
    }) => (
      <textarea
        aria-label="SKILL.md"
        value={value}
        readOnly={editable === false}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
    Alert: { alert: mocks.alert },
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

const own = {
  id: "skill-1",
  name: "weekly-review",
  description: "Review the week",
  content: "---\nname: weekly-review\ndescription: Review the week\n---\n\nList what shipped.\n",
  source: "user",
  readOnly: false,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.params = {};
  mocks.options = {};
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

async function settle() {
  await act(flush);
}
async function render() {
  await act(async () => root.render(<SkillScreen />));
  await settle();
}
function editor() {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      editor(),
      text,
    );
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function headerSave() {
  const holder = document.createElement("div");
  const header = createRoot(holder);
  act(() => header.render(mocks.options.headerRight?.()));
  const save = holder.querySelector("button") as HTMLButtonElement | null;
  return { save, unmount: () => act(() => header.unmount()) };
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
async function pressSave(times = 1) {
  const { save, unmount } = headerSave();
  await act(async () => {
    for (let tap = 0; tap < times; tap += 1) save?.click();
  });
  unmount();
}
async function confirmDelete() {
  await act(async () => button("Delete").click());
  const buttons = mocks.alert.mock.lastCall?.[2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => buttons.find((b) => b.text === "Delete")?.onPress?.());
}
/** Answers the skill's read, and holds the named write open so a test decides how it ends. */
function hold(write: string) {
  let finish!: (outcome?: Error) => void;
  mocks.rpc.mockImplementation((proc: string, body: Record<string, unknown>) =>
    proc === "agentSkills/get"
      ? Promise.resolve(own)
      : proc === write
        ? new Promise((resolve, reject) => {
            finish = (outcome) =>
              outcome ? reject(outcome) : resolve({ ...own, content: body.content ?? own.content });
          })
        : Promise.reject(new Error(`Unexpected ${proc}`)),
  );
  return {
    finish: (outcome?: Error) => act(async () => finish(outcome)),
    calls: () => mocks.rpc.mock.calls.filter(([proc]) => proc === write),
  };
}

/** What every write carries: the server, session and space its save was started in. */
const pinned = {
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  },
};
it("opens a saved skill, saves an edit from the header, and deletes after a native confirm", async () => {
  mocks.params = { id: own.id };
  mocks.rpc.mockImplementation(async (proc: string, body: Record<string, unknown>) => {
    if (proc === "agentSkills/get") return own;
    if (proc === "agentSkills/update") return { ...own, content: body.content };
    if (proc === "agentSkills/remove") return { ok: true };
    throw new Error(`Unexpected ${proc}`);
  });
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/get", { skillId: own.id }, expect.anything());
  expect(editor().value).toBe(own.content);
  expect(mocks.options.title).toBe("weekly-review");
  expect(headerSave().save?.disabled).toBe(true);

  await type(`${own.content}Note what slipped.\n`);
  const { save, unmount } = headerSave();
  expect(save?.disabled).toBe(false);
  await act(async () => save?.click());
  unmount();
  expect(mocks.rpc).toHaveBeenCalledWith(
    "agentSkills/update",
    { skillId: own.id, content: `${own.content}Note what slipped.\n` },
    pinned,
  );

  await act(async () => button("Delete").click());
  expect(mocks.rpc).not.toHaveBeenCalledWith("agentSkills/remove", expect.anything(), pinned);
  const [title, , buttons] = mocks.alert.mock.calls[0] as [
    string,
    undefined,
    Array<{ text: string; onPress?: () => void }>,
  ];
  expect(title).toBe("Delete weekly-review?");
  await act(async () => buttons.find((b) => b.text === "Delete")?.onPress?.());
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/remove", { skillId: own.id }, pinned);
  expect(mocks.back).toHaveBeenCalled();
});

it("shows a built-in skill read-only, without Save or Delete", async () => {
  mocks.params = { id: "builtin-1" };
  mocks.rpc.mockResolvedValue({ ...own, id: "builtin-1", source: "builtin", readOnly: true });
  await render();
  expect(editor().readOnly).toBe(true);
  expect(mocks.options.headerRight).toBeUndefined();
  expect(container.textContent).not.toContain("Delete");
});

it("keeps a skill that failed to load from being saved as a new one, and retries", async () => {
  mocks.params = { id: "own-1" };
  mocks.rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(own);
  await render();
  expect(container.querySelector('[aria-label="SKILL.md"]')).toBeNull();
  expect(mocks.rpc).not.toHaveBeenCalledWith("agentSkills/create", expect.anything(), pinned);
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(container.textContent).toContain("offline");
  await act(async () => retry?.click());
  await settle();
  expect(editor().value).toBe(own.content);
  expect(container.textContent).not.toContain("offline");
});

it("creates a new skill from the template and goes back", async () => {
  mocks.rpc.mockResolvedValue(own);
  await render();
  expect(mocks.options.title).toBe("New skill");
  expect(editor().value).toContain("name: my-skill");
  const { save, unmount } = headerSave();
  await act(async () => save?.click());
  unmount();
  expect(mocks.rpc).toHaveBeenCalledWith(
    "agentSkills/create",
    { content: expect.stringContaining("name: my-skill") },
    pinned,
  );
  expect(mocks.back).toHaveBeenCalled();
});

it("reads the skill again on a later visit instead of showing the earlier copy", async () => {
  mocks.params = { id: own.id };
  const answer = deferred<typeof own>();
  mocks.rpc.mockResolvedValueOnce(own).mockReturnValueOnce(answer.promise);
  await render();
  expect(editor().value).toBe(own.content);
  await act(async () => root.render(null));
  await settle();

  await render();
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => answer.resolve({ ...own, content: "Edited since.\n" }));
  await settle();
  expect(editor().value).toBe("Edited since.\n");
});

it("holds the editor, Save and Delete while a save runs, and saves once for two taps", async () => {
  mocks.params = { id: own.id };
  const update = hold("agentSkills/update");
  await render();
  await type(`${own.content}More.\n`);
  await pressSave(2);
  expect(update.calls()).toHaveLength(1);
  expect(editor().readOnly).toBe(true);
  expect(button("Delete").disabled).toBe(true);
  expect(headerSave().save?.disabled).toBe(true);

  await update.finish();
  expect(editor().readOnly).toBe(false);
  expect(button("Delete").disabled).toBe(false);
  expect(headerSave().save?.disabled).toBe(true);
  expect(mocks.back).not.toHaveBeenCalled();
});

it("shows a failed save or delete until the next save or delete starts", async () => {
  mocks.params = { id: own.id };
  const update = hold("agentSkills/update");
  await render();
  await type(`${own.content}More.\n`);
  await pressSave();
  await update.finish(new Error("Name taken"));
  expect(container.textContent).toContain("Name taken");
  expect(editor().readOnly).toBe(false);
  expect(headerSave().save?.disabled).toBe(false);

  const remove = hold("agentSkills/remove");
  await confirmDelete();
  expect(container.textContent).not.toContain("Name taken");
  await remove.finish(new Error("Still in use"));
  expect(container.textContent).toContain("Still in use");
  expect(button("Delete").disabled).toBe(false);
  expect(mocks.back).not.toHaveBeenCalled();

  hold("agentSkills/update");
  await pressSave();
  expect(container.textContent).not.toContain("Still in use");
});

it("keeps Delete held after a delete that closes the screen", async () => {
  mocks.params = { id: own.id };
  const remove = hold("agentSkills/remove");
  await render();
  await confirmDelete();
  expect(button("Delete").disabled).toBe(true);
  await remove.finish();
  expect(mocks.back).toHaveBeenCalledTimes(1);
  expect(button("Delete").disabled).toBe(true);
  expect(editor().readOnly).toBe(true);
});

it.each([
  ["agentSkills/create", undefined, () => pressSave()],
  ["agentSkills/remove", own.id, () => confirmDelete()],
] as const)("does not go back when %s ends after the screen has gone", async (write, id, start) => {
  mocks.params = id ? { id } : {};
  const pending = hold(write);
  await render();
  await start();
  expect(pending.calls()).toHaveLength(1);
  await act(async () => root.render(null));
  await pending.finish();
  expect(mocks.back).not.toHaveBeenCalled();
});
