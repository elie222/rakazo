// @vitest-environment jsdom
import type { BotPackageDocument, BotPackagePreview, BotPackageReceipt } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  file: vi.fn(),
  download: vi.fn(),
  current: true,
}));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () => ({
    botPackages: Object.fromEntries(
      [
        "preview",
        "import",
        "status",
        "recent",
        "resume",
        "cancel",
        "forBot",
        "activateSkill",
        "export",
      ].map((method) => [method, (input: unknown) => api.request(method, input)]),
    ),
    agentSkills: { list: () => api.request("skills", {}) },
  }),
}));
vi.mock("../lib/bot-package-file", () => ({
  readBotPackageFile: api.file,
  downloadBotPackage: api.download,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange(value: boolean): void }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { BotPackageImport } from "./BotPackageImport";
import { BotPackageSkills, BotPackageTools } from "./BotPackageTools";

const documentFixture: BotPackageDocument = {
  format: "coginebot.package/v1",
  profile: {
    name: "Research copy",
    title: "Review sources",
    description: "Synthetic bot",
    instructions: "First line\n<img src=x onerror=alert(1)>\nLast line\n",
  },
  skills: [
    {
      name: "research",
      description: "Check sources",
      content: "---\nname: research\ndescription: Check sources\n---\n\nKeep exact text.\n",
    },
  ],
  routines: [
    { name: "Daily check", prompt: "Review sources", crons: ["0 9 * * 1-5"], timezone: "UTC" },
  ],
  connections: [{ name: "GitHub", note: "Connect your own account" }],
  memory: [],
};
const previewFixture: BotPackagePreview = {
  previewToken: "review-token",
  digest: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
  sourceFormat: "coginebot.package/v1",
  includeMemory: false,
  availableMemoryCount: 1,
  document: documentFixture,
  leftOut: [{ kind: "routine", name: "On new email", reason: "Event triggers need manual setup" }],
};
const receiptFixture: BotPackageReceipt = {
  importId: "import-one",
  clientNonce: "nonce-one",
  digest: "a".repeat(64),
  status: "completed",
  revision: 1,
  botId: "bot-new",
  botName: "Research copy",
  createdAt: "2026-11-02T00:00:00.000Z",
  skills: [
    {
      ...documentFixture.skills[0]!,
      id: "component-one",
      key: "skill:0",
      status: "pending",
      revision: 1,
      skillId: null,
    },
  ],
  connections: [{ ...documentFixture.connections[0]!, id: "need-one", key: "connection:0" }],
  leftOut: [],
};
let receipt = receiptFixture;
let node: HTMLDivElement;
let root: Root;
const onImported = vi.fn();
const onOpen = vi.fn();
const current = () => api.current;
beforeEach(() => {
  vi.clearAllMocks();
  api.current = true;
  receipt = structuredClone(receiptFixture);
  api.request.mockImplementation(async (method, input) => {
    if (method === "preview")
      return {
        ...previewFixture,
        includeMemory: input.includeMemory,
        document: {
          ...documentFixture,
          profile: { ...documentFixture.profile, name: input.name || documentFixture.profile.name },
        },
      };
    if (method === "import") {
      receipt = { ...receipt, clientNonce: input.clientNonce };
      return receipt;
    }
    if (method === "status") return receipt;
    if (method === "forBot") return input.botId === receipt.botId ? receipt : null;
    if (method === "recent") return [{ ...receipt, skillCount: 1, connectionCount: 1 }];
    if (method === "skills")
      return [
        { id: "owned-skill", name: "Own shared recipe", source: "user" },
        { id: "builtin:one", name: "Built-in recipe", source: "builtin" },
      ];
    if (method === "export")
      return { json: "{}", filename: "bot.json", document: documentFixture, leftOut: [] };
    throw new Error(`Unexpected ${method}`);
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
async function mount() {
  await act(async () =>
    root.render(
      <BotPackageImport
        spaceId="space-a"
        isCurrent={current}
        onImported={onImported}
        onOpen={onOpen}
        onCancel={() => {}}
        onConnections={() => {}}
      />,
    ),
  );
}
function field(label: string) {
  return (node.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`) ??
    [...node.querySelectorAll<HTMLInputElement>("input")].find((input) =>
      [...(input.labels ?? [])].some((entry) => entry.textContent?.trim().startsWith(label)),
    ) ??
    null)!;
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
function button(label: string) {
  return [...node.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
const writes = () => api.request.mock.calls.filter(([method]) => method === "import");

it("requires preview and explicit new-copy confirmation, renders external instructions as plain text", async () => {
  await mount();
  expect((field("Include memory") as HTMLInputElement).checked).toBe(false);
  await fill("Bot package or Grok JSON", '{"format":"coginebot.package/v1"}');
  await click("Preview");
  expect(writes()).toHaveLength(0);
  expect(node.querySelector("pre")?.textContent).toBe(documentFixture.profile.instructions);
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain("Event triggers need manual setup");
  expect(node.textContent).toContain("Skills stay off. Routines stay paused.");
  await click("Import as new bot");
  expect(writes()).toHaveLength(1);
  expect(Object.keys(writes()[0]![1]).sort()).toEqual(["clientNonce", "previewToken"]);
  expect(onImported).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
  expect(node.textContent).toContain("Enabling a skill shares it with your bots in this space.");
  await click("Open bot");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("bot-new");
});

it("invalidates the old preview when name or memory selection changes", async () => {
  await mount();
  await fill("Bot package or Grok JSON", "{}");
  await click("Preview");
  await fill("Imported bot name", "Chosen copy");
  expect(button("Import as new bot")).toBeUndefined();
  await act(async () => field("Include memory").click());
  await click("Preview");
  expect(api.request.mock.calls.filter(([method]) => method === "preview").at(-1)![1]).toEqual({
    source: "{}",
    name: "Chosen copy",
    includeMemory: true,
  });
});

it("reads back a lost import reply without creating a second bot or losing the confirmed receipt", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation(async (method, input) => {
    if (method === "import") {
      receipt = { ...receipt, clientNonce: input.clientNonce };
      throw new Error("reply lost");
    }
    return normal(method, input);
  });
  await mount();
  await fill("Bot package or Grok JSON", "{}");
  await click("Preview");
  await click("Import as new bot");
  expect(field("Bot package or Grok JSON").disabled).toBe(true);
  expect(button("Resume import")).toBeUndefined();
  await click("Check status");
  expect(node.textContent).toContain("Bot imported");
  expect(writes()).toHaveLength(1);
  expect(onImported).toHaveBeenCalledOnce();
});

it("does not overwrite a later pasted source with a slow file read", async () => {
  let finish!: (source: string) => void;
  api.file.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await mount();
  const fileInput = field("Choose package file");
  Object.defineProperty(fileInput, "files", { value: [new File(["old"], "old.json")] });
  await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
  await fill("Bot package or Grok JSON", "new source");
  await act(async () => finish("old source"));
  expect(field("Bot package or Grok JSON").value).toBe("new source");
  expect(field("Choose package file").disabled).toBe(false);
});

it("discards a delayed preview after the editor authority expires", async () => {
  let finish!: (value: BotPackagePreview) => void;
  api.request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await mount();
  await fill("Bot package or Grok JSON", "{}");
  await act(async () => button("Preview").click());
  api.current = false;
  await act(async () => finish(previewFixture));
  expect(node.querySelector('[data-testid="bot-package-document"]')).toBeNull();
  expect(button("Import as new bot")).toBeUndefined();
});

it("recovers a chosen recent import explicitly, without automatically resuming it", async () => {
  await mount();
  expect(api.request.mock.calls.some(([method]) => method === "status")).toBe(false);
  await click("Recent imports");
  expect(api.request.mock.calls.some(([method]) => method === "status")).toBe(false);
  await click("Review import");
  expect(node.textContent).toContain("Bot imported");
  expect(writes()).toHaveLength(0);
});

it("keeps skill activation explicit, revision bound and read-before-retry after a lost reply", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation(async (method, input) => {
    if (method === "activateSkill") {
      receipt = {
        ...receipt,
        revision: 2,
        skills: [
          {
            ...receipt.skills[0]!,
            status: "activated",
            revision: 2,
            skillId: "new-shared-skill",
            name: input.name,
          },
        ],
      };
      throw new Error("reply lost");
    }
    return normal(method, input);
  });
  await act(async () =>
    root.render(<BotPackageSkills botId="bot-new" spaceId="space-a" isCurrent={current} />),
  );
  await fill("Skill name", "reviewed-name");
  await click("Enable shared skill");
  expect(api.request.mock.calls.filter(([method]) => method === "activateSkill")[0]![1]).toEqual({
    componentId: "component-one",
    expectedRevision: 1,
    name: "reviewed-name",
  });
  expect(button("Enable shared skill").disabled).toBe(true);
  await click("Check status");
  expect(button("Enable shared skill")).toBeUndefined();
  expect(node.textContent).toContain("Enabled");
  expect(api.request.mock.calls.filter(([method]) => method === "activateSkill")).toHaveLength(1);
});

it("exports no unrelated shared skills or memory by default and cancels stale delivery", async () => {
  let finish!: (value: unknown) => void;
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((method, input) =>
    method === "export" ? new Promise((resolve) => (finish = resolve)) : normal(method, input),
  );
  await act(async () =>
    root.render(<BotPackageTools botId="bot-old" spaceId="space-a" isCurrent={current} />),
  );
  await click("Export package");
  expect((field("Include memory") as HTMLInputElement).checked).toBe(false);
  expect(field("Own shared recipe")).toBeTruthy();
  expect(field("Built-in recipe")).toBeNull();
  await act(async () => button("Preview package").click());
  expect(api.request.mock.calls.filter(([method]) => method === "export")[0]![1]).toEqual({
    botId: "bot-old",
    skillIds: [],
    includeMemory: false,
  });
  api.current = false;
  await act(async () =>
    finish({ json: "{}", filename: "bot.json", document: documentFixture, leftOut: [] }),
  );
  expect(api.download).not.toHaveBeenCalled();
});

it("searches beyond the first export page while preserving exact selected IDs across pages", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((method, input) =>
    method === "skills"
      ? Promise.resolve(
          Array.from({ length: 260 }, (_, index) => ({
            id: `skill-${index}`,
            name: `Recipe ${index}`,
            description: "Reusable recipe",
            source: "user",
          })),
        )
      : normal(method, input),
  );
  await act(async () =>
    root.render(<BotPackageTools botId="bot-old" spaceId="space-a" isCurrent={current} />),
  );
  await click("Export package");
  expect(field("Recipe 75")).toBeNull();
  await act(async () => field("Recipe 0").click());
  await click("Show more");
  await act(async () => field("Recipe 75").click());
  await fill("Search shared skills", "Recipe 259");
  await act(async () => field("Recipe 259").click());
  await click("Preview package");
  expect(api.request.mock.calls.filter(([method]) => method === "export")[0]![1]).toEqual({
    botId: "bot-old",
    skillIds: ["skill-0", "skill-75", "skill-259"],
    includeMemory: false,
  });
  expect(api.download).not.toHaveBeenCalled();
  await click("Download package");
  expect(api.download).toHaveBeenCalledOnce();
});

it("reviews the export and omissions before delivery and invalidates the review when choices change", async () => {
  const normal = api.request.getMockImplementation()!;
  api.request.mockImplementation((method, input) =>
    method === "export"
      ? Promise.resolve({
          json: "{}",
          filename: "bot.json",
          document: documentFixture,
          leftOut: [{ kind: "memory", name: "memory", reason: "Memory was not selected." }],
        })
      : normal(method, input),
  );
  await act(async () =>
    root.render(<BotPackageTools botId="bot-old" spaceId="space-a" isCurrent={current} />),
  );
  await click("Export package");
  expect(button("Download package")).toBeUndefined();
  await click("Preview package");
  expect(node.querySelector('[data-testid="bot-package-document"]')).not.toBeNull();
  expect(node.textContent).toContain("Memory was not selected.");
  expect(api.download).not.toHaveBeenCalled();
  await act(async () => field("Include memory").click());
  expect(button("Download package")).toBeUndefined();
  expect(node.querySelector('[data-testid="bot-package-document"]')).toBeNull();
  await click("Preview package");
  await click("Download package");
  expect(api.download).toHaveBeenCalledOnce();
  expect(api.request.mock.calls.filter(([method]) => method === "export")).toHaveLength(2);
  expect(button("Download package")).toBeUndefined();
});
