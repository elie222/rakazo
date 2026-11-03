// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SkillScreen from "../app/(settings)/skill";

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
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
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

async function render() {
  await act(async () => root.render(<SkillScreen />));
  await act(async () => undefined);
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

it("opens a saved skill, saves an edit from the header, and deletes after a native confirm", async () => {
  mocks.params = { id: own.id };
  mocks.rpc.mockImplementation(async (proc: string, body: Record<string, unknown>) => {
    if (proc === "agentSkills/get") return own;
    if (proc === "agentSkills/update") return { ...own, content: body.content };
    if (proc === "agentSkills/remove") return { ok: true };
    throw new Error(`Unexpected ${proc}`);
  });
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/get", { skillId: own.id });
  expect(editor().value).toBe(own.content);
  expect(mocks.options.title).toBe("weekly-review");
  expect(headerSave().save?.disabled).toBe(true);

  await type(`${own.content}Note what slipped.\n`);
  const { save, unmount } = headerSave();
  expect(save?.disabled).toBe(false);
  await act(async () => save?.click());
  unmount();
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/update", {
    skillId: own.id,
    content: `${own.content}Note what slipped.\n`,
  });

  await act(async () => button("Delete").click());
  expect(mocks.rpc).not.toHaveBeenCalledWith("agentSkills/remove", expect.anything());
  const [title, , buttons] = mocks.alert.mock.calls[0] as [
    string,
    undefined,
    Array<{ text: string; onPress?: () => void }>,
  ];
  expect(title).toBe("Delete weekly-review?");
  await act(async () => buttons.find((b) => b.text === "Delete")?.onPress?.());
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/remove", { skillId: own.id });
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
  expect(mocks.rpc).not.toHaveBeenCalledWith("agentSkills/create", expect.anything());
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  await act(async () => retry?.click());
  expect(editor().value).toBe(own.content);
});

it("creates a new skill from the template and goes back", async () => {
  mocks.rpc.mockResolvedValue(own);
  await render();
  expect(mocks.options.title).toBe("New skill");
  expect(editor().value).toContain("name: my-skill");
  const { save, unmount } = headerSave();
  await act(async () => save?.click());
  unmount();
  expect(mocks.rpc).toHaveBeenCalledWith("agentSkills/create", {
    content: expect.stringContaining("name: my-skill"),
  });
  expect(mocks.back).toHaveBeenCalled();
});
