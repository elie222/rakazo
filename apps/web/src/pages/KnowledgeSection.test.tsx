// @vitest-environment jsdom

import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), get: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { agentSkills: api, memory: { list: async () => [] } },
}));
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: vi.fn() }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Skeleton: Container,
    Tabs: Container,
    TabsList: Container,
    TabsTrigger: Container,
    TabsContent: Container,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  };
});

import { KnowledgeSection } from "./KnowledgeSection";

it("disables skill rows while a completed save is refreshing the catalog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const skill = {
    id: "skill-fixture",
    name: "greeting",
    description: "Greet politely",
    content: "Hello",
  };
  let finishRefresh!: (value: (typeof skill)[]) => void;
  const refresh = new Promise<(typeof skill)[]>((resolve) => {
    finishRefresh = resolve;
  });
  api.list.mockResolvedValueOnce([skill]).mockReturnValueOnce(refresh);
  api.create.mockResolvedValue(skill);
  api.get.mockResolvedValue(skill);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () =>
      root.render(<KnowledgeSection botId="bot-fixture" onSkillsChange={() => undefined} />),
    );
    await act(async () => button("New skill").click());
    await act(async () => button("Save").click());
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(button("greeting").disabled).toBe(true);
    await act(async () => button("greeting").click());
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => finishRefresh([skill]));
    expect(button("greeting").disabled).toBe(false);
    await act(async () => button("greeting").click());
    expect(container.querySelector("textarea")?.value).toBe("Hello");
  } finally {
    await act(async () => {
      finishRefresh([skill]);
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("labels the skills tab as shared and badges built-in and plugin skills", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog: AgentSkillCatalogEntry[] = [
    {
      id: "builtin:interrogate",
      name: "Interrogate",
      description: "Review a change",
      source: "builtin",
      readOnly: true,
    },
    {
      id: "plugin:mail",
      name: "Triage mail",
      description: "Sort the inbox",
      source: "plugin",
      readOnly: true,
    },
    {
      id: "user-1",
      name: "greeting",
      description: "Greet politely",
      source: "user",
      readOnly: false,
    },
  ];
  api.list.mockReset();
  api.get.mockReset();
  api.list.mockResolvedValueOnce(catalog);
  api.get.mockImplementation(async ({ skillId }: { skillId: string }) => {
    const entry = catalog.find((skill) => skill.id === skillId);
    if (!entry) throw new Error(`Missing skill: ${skillId}`);
    return { ...entry, content: "Steps", createdAt: "", updatedAt: "" };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () =>
      root.render(<KnowledgeSection botId="bot-fixture" onSkillsChange={() => undefined} />),
    );
    expect(container.textContent).toContain("Shared skills");
    expect(button("Interrogate").textContent).toContain("Built-in");
    expect(button("Triage mail").textContent).toContain("Plugin");
    expect(button("greeting").textContent).not.toContain("Built-in");
    expect(button("greeting").textContent).not.toContain("Plugin");
    await act(async () => button("Interrogate").click());
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
    expect(container.textContent).toContain("Built-in");
    expect(button("Close")).toBeTruthy();
    expect(container.textContent).not.toContain("Delete");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
