// @vitest-environment jsdom
import type { BotPackageDocument, BotPackagePreview, BotPackageReceipt } from "@rakazo/contracts";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  pick: vi.fn(),
  share: vi.fn(),
  current: true,
  generation: 1,
  focusCleanup: undefined as (() => void) | undefined,
  listeners: new Set<() => void>(),
}));
vi.mock("./bot-package-client", () => ({
  mobileBotPackageClient: async (_scope: unknown, isMounted: () => boolean) => {
    const generation = api.generation;
    return {
      isCurrent: () => isMounted() && api.current && generation === api.generation,
      request: (procedure: string, input: unknown) => api.request(procedure, input),
    };
  },
}));
vi.mock("./bot-package-file", () => ({
  pickBotPackageFile: api.pick,
  shareBotPackageFile: api.share,
  BotPackageFileError: class extends Error {},
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    spaceId: "space-a",
    spaceGeneration: api.generation,
    selectionSeq: api.generation,
  }),
  mobileScopeKey: () => `scope-${api.generation}`,
  subscribeMobileScope: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: EffectCallback) =>
    useEffect(() => {
      const cleanup = callback();
      api.focusCleanup = typeof cleanup === "function" ? cleanup : undefined;
      return cleanup;
    }, [callback]),
}));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("div", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    editable,
    onChangeText,
    accessibilityLabel,
    multiline,
  }: {
    value: string;
    editable?: boolean;
    onChangeText(value: string): void;
    accessibilityLabel?: string;
    multiline?: boolean;
  }) =>
    createElement(multiline ? "textarea" : "input", {
      value,
      disabled: editable === false,
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    busy,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    onPress(): void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled: disabled || busy, onClick: onPress },
      label,
    ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange(value: boolean): void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: (event: { target: { checked: boolean } }) => onValueChange(event.target.checked),
    }),
}));
vi.mock("./native", () => ({ native: {} }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      key.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match)),
  }),
}));

import { NativeBotPackageImport } from "../components/bot-package-import";
import { NativeBotPackageSkills, NativeBotPackageTools } from "../components/bot-package-tools";
import type { MobileBotPackageClient } from "./bot-package-client";
import type { MobileScope } from "./mobile-scope";

const scope: MobileScope = {
  apiBase: "https://api.example.test",
  sessionGeneration: 1,
  spaceId: "space-a",
  spaceGeneration: 1,
  selectionSeq: 1,
};
const doc: BotPackageDocument = {
  format: "coginebot.package/v1",
  profile: {
    name: "Native copy",
    title: "Review",
    description: "Synthetic",
    instructions: "Raw instructions\n<script>never execute</script>\n",
  },
  skills: [
    {
      name: "recipe",
      description: "A recipe",
      content: "---\nname: recipe\ndescription: A recipe\n---\n\nExact skill.\n",
    },
  ],
  routines: [{ name: "Daily", prompt: "Review", crons: ["0 9 * * *"], timezone: "UTC" }],
  connections: [{ name: "GitHub", note: "Set up your own account" }],
  memory: [],
};
const preview: BotPackagePreview = {
  previewToken: "preview-one",
  digest: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
  sourceFormat: "openmaus.grok/1",
  document: doc,
  leftOut: [{ kind: "routine", name: "On email", reason: "Event triggers need manual setup" }],
  includeMemory: false,
  availableMemoryCount: 1,
};
const baseReceipt: BotPackageReceipt = {
  importId: "import-one",
  clientNonce: "nonce-one",
  digest: "a".repeat(64),
  status: "completed",
  revision: 1,
  botId: "new-bot",
  botName: "Native copy",
  createdAt: "2026-11-02T00:00:00.000Z",
  skills: [
    {
      ...doc.skills[0]!,
      id: "component-one",
      key: "skill:0",
      status: "pending",
      revision: 1,
      skillId: null,
    },
  ],
  connections: [{ ...doc.connections[0]!, id: "need-one", key: "connection:0" }],
  leftOut: [],
};
let receipt: BotPackageReceipt;
let root: Root;
let node: HTMLDivElement;
const onOpen = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  api.current = true;
  api.generation = 1;
  api.listeners.clear();
  api.focusCleanup = undefined;
  receipt = structuredClone(baseReceipt);
  api.pick.mockResolvedValue(null);
  api.share.mockResolvedValue(undefined);
  api.request.mockImplementation(async (procedure, input) => {
    if (procedure === "botPackages/preview")
      return { ...preview, includeMemory: input.includeMemory };
    if (procedure === "botPackages/import") {
      receipt = { ...receipt, clientNonce: input.clientNonce };
      return receipt;
    }
    if (procedure === "botPackages/status" || procedure === "botPackages/forBot") return receipt;
    if (procedure === "botPackages/recent")
      return [{ ...receipt, skillCount: 1, connectionCount: 1 }];
    if (procedure === "agentSkills/list")
      return [
        { id: "owned", name: "Own recipe", description: "Reusable", source: "user" },
        { id: "builtin:one", name: "Builtin recipe", source: "builtin" },
      ];
    if (procedure === "botPackages/export")
      return { document: doc, json: "{}", filename: "bot.json", leftOut: [] };
    throw new Error(`Unexpected ${procedure}`);
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
function field(label: string) {
  return node.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
}
function button(label: string) {
  return [...node.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mountImport() {
  await act(async () =>
    root.render(
      <NativeBotPackageImport
        scope={scope}
        onOpen={onOpen}
        onConnections={() => {}}
        onClose={() => {}}
      />,
    ),
  );
}
const imports = () =>
  api.request.mock.calls.filter(([procedure]) => procedure === "botPackages/import");

it("previews native text as data and creates only after the explicit new-copy action", async () => {
  await mountImport();
  expect((field("Include memory") as HTMLInputElement).checked).toBe(false);
  await fill("Bot package or Grok JSON", "{}");
  await click("Preview");
  expect(imports()).toHaveLength(0);
  await click("Instructions");
  expect(node.textContent).toContain(doc.profile.instructions);
  expect(node.querySelector("script")).toBeNull();
  expect(node.textContent).toContain("Event triggers need manual setup");
  await click("Import as new bot");
  expect(imports()).toHaveLength(1);
  expect(node.textContent).toContain("Enabling a skill shares it with your bots in this space.");
  expect(onOpen).not.toHaveBeenCalled();
  await click("Open bot");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("new-bot", "Native copy");
});

it("invalidates a native preview when memory selection changes", async () => {
  await mountImport();
  await fill("Bot package or Grok JSON", "{}");
  await click("Preview");
  await act(async () => field("Include memory").click());
  expect(button("Import as new bot")).toBeUndefined();
  await click("Preview");
  expect(
    api.request.mock.calls.filter(([name]) => name === "botPackages/preview").at(-1)![1]
      .includeMemory,
  ).toBe(true);
});

it("keeps a cancelled file picker from clearing typed input", async () => {
  await mountImport();
  await fill("Bot package or Grok JSON", "keep this draft");
  await click("Choose package file");
  expect(field("Bot package or Grok JSON").value).toBe("keep this draft");
  expect(imports()).toHaveLength(0);
});

it("discards a slow file selection after a newer text edit", async () => {
  let finish!: (source: string) => void;
  api.pick.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await mountImport();
  await act(async () => button("Choose package file").click());
  await fill("Bot package or Grok JSON", "new source");
  await act(async () => finish("old source"));
  expect(field("Bot package or Grok JSON").value).toBe("new source");
  expect(button("Choose package file").disabled).toBe(false);
});

it("clears source on blur and rejects late picker input even when the route remains mounted", async () => {
  let finish!: (source: string) => void;
  api.pick.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await mountImport();
  await fill("Bot package or Grok JSON", "private draft");
  await act(async () => button("Choose package file").click());
  await act(async () => api.focusCleanup?.());
  await act(async () => finish("late private text"));
  expect(field("Bot package or Grok JSON").value).toBe("");
  expect(imports()).toHaveLength(0);
});

it("checks the same nonce after a lost import reply without replaying a write", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation(async (procedure, input) => {
    if (procedure === "botPackages/import") {
      receipt = { ...receipt, clientNonce: input.clientNonce };
      throw new Error("reply lost");
    }
    return normal(procedure, input);
  });
  await mountImport();
  await fill("Bot package or Grok JSON", "{}");
  await click("Preview");
  await click("Import as new bot");
  expect(field("Bot package or Grok JSON").disabled).toBe(true);
  await click("Check status");
  expect(node.textContent).toContain("Bot imported");
  expect(imports()).toHaveLength(1);
});

it("reopens a selected recent receipt without automatic import or resume", async () => {
  await mountImport();
  await click("Recent imports");
  expect(api.request.mock.calls.filter(([name]) => name === "botPackages/status")).toHaveLength(0);
  await click("Review import");
  expect(node.textContent).toContain("Bot imported");
  expect(imports()).toHaveLength(0);
});

it("requires a skill name and exact revision, then reads back a lost activation reply", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation(async (procedure, input) => {
    if (procedure === "botPackages/activateSkill") {
      receipt = {
        ...receipt,
        revision: 2,
        skills: [
          {
            ...receipt.skills[0]!,
            name: input.name,
            revision: 2,
            status: "activated",
            skillId: "shared-new",
          },
        ],
      };
      throw new Error("reply lost");
    }
    return normal(procedure, input);
  });
  const client = {
    request: (procedure: string, input: unknown) => api.request(procedure, input),
    isCurrent: () => api.current,
  } as MobileBotPackageClient;
  await act(async () => root.render(<NativeBotPackageSkills botId="new-bot" client={client} />));
  await click("recipe");
  await fill("Skill name", "new-recipe");
  await click("Enable shared skill");
  expect(
    api.request.mock.calls.filter(([name]) => name === "botPackages/activateSkill")[0]![1],
  ).toEqual({ componentId: "component-one", expectedRevision: 1, name: "new-recipe" });
  expect(button("Enable shared skill").disabled).toBe(true);
  await click("Check status");
  expect(node.textContent).toContain("Enabled");
  expect(button("Enable shared skill")).toBeUndefined();
});

it("keeps native export selections empty and never shares a stale account's result", async () => {
  let finish!: (value: unknown) => void;
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((procedure, input) =>
    procedure === "botPackages/export"
      ? new Promise((resolve) => (finish = resolve))
      : normal(procedure, input),
  );
  await act(async () => root.render(<NativeBotPackageTools botId="new-bot" />));
  await click("Export package");
  expect((field("Include memory") as HTMLInputElement).checked).toBe(false);
  expect(field("Builtin recipe")).toBeNull();
  await act(async () => button("Preview package").click());
  expect(api.request.mock.calls.filter(([name]) => name === "botPackages/export")[0]![1]).toEqual({
    botId: "new-bot",
    skillIds: [],
    includeMemory: false,
  });
  await act(async () => api.focusCleanup?.());
  await act(async () => finish({ document: doc, json: "{}", filename: "bot.json", leftOut: [] }));
  expect(api.share).not.toHaveBeenCalled();
});

it("preserves native selected IDs while searching and paging a large shared catalog", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((procedure, input) =>
    procedure === "agentSkills/list"
      ? Promise.resolve(
          Array.from({ length: 260 }, (_, index) => ({
            id: `skill-${index}`,
            name: `Recipe ${index}`,
            description: "Reusable recipe",
            source: "user",
          })),
        )
      : normal(procedure, input),
  );
  await act(async () => root.render(<NativeBotPackageTools botId="new-bot" />));
  await click("Export package");
  expect(field("Recipe 75")).toBeNull();
  await act(async () => field("Recipe 0").click());
  await click("Show more");
  await act(async () => field("Recipe 75").click());
  await fill("Search shared skills", "Recipe 259");
  await act(async () => field("Recipe 259").click());
  await click("Preview package");
  expect(api.request.mock.calls.filter(([name]) => name === "botPackages/export")[0]![1]).toEqual({
    botId: "new-bot",
    skillIds: ["skill-0", "skill-75", "skill-259"],
    includeMemory: false,
  });
  expect(api.share).not.toHaveBeenCalled();
  await click("Share package");
  expect(api.share).toHaveBeenCalledOnce();
  expect(node.textContent).not.toContain("Saved");
});

it("reviews native export omissions before OS handoff and invalidates choices before sharing", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((procedure, input) =>
    procedure === "botPackages/export"
      ? Promise.resolve({
          document: doc,
          json: "{}",
          filename: "bot.json",
          leftOut: [{ kind: "memory", name: "memory", reason: "Memory was not selected." }],
        })
      : normal(procedure, input),
  );
  await act(async () => root.render(<NativeBotPackageTools botId="new-bot" />));
  await click("Export package");
  expect(button("Share package")).toBeUndefined();
  await click("Preview package");
  expect(node.textContent).toContain("Memory was not selected.");
  expect(api.share).not.toHaveBeenCalled();
  await act(async () => field("Include memory").click());
  expect(button("Share package")).toBeUndefined();
  expect(node.textContent).not.toContain("Memory was not selected.");
  await click("Preview package");
  await click("Share package");
  expect(api.share).toHaveBeenCalledOnce();
  expect(api.request.mock.calls.filter(([name]) => name === "botPackages/export")).toHaveLength(2);
  expect(button("Share package")).toBeUndefined();
});
