// @vitest-environment jsdom

import type { AgentSkillCatalogEntry, Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const skillsApi = vi.hoisted(() => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  listBots: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    agentSkills: {
      list: skillsApi.listSkills,
      get: skillsApi.getSkill,
      create: skillsApi.createSkill,
      update: skillsApi.updateSkill,
      remove: skillsApi.deleteSkill,
    },
    bots: {
      list: skillsApi.listBots,
    },
  },
}));

vi.mock("@rakazo/ui-web", () => {
  return {
    Badge: ({ children, className }: { children: ReactNode; className?: string }) => (
      <span className={className} data-testid="badge">
        {children}
      </span>
    ),
    BotAvatar: ({ identity }: { identity: string }) => (
      <span data-testid={`bot-avatar-${identity}`} />
    ),
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Card: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    CardTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
      <h3 className={className}>{children}</h3>
    ),
    CardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Checkbox: ({
      checked,
      onCheckedChange,
    }: {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
    ),
    Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
      <h2 className={className}>{children}</h2>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Skeleton: ({ className }: { className?: string }) => <div className={className} />,
  };
});

import { SkillsTab } from "./SkillsTab";

function makeMockBot(partial: Partial<Bot> & { id: string; name: string }): Bot {
  return {
    spaceId: "space-1",
    title: "",
    description: "",
    instructions: "",
    color: "blue",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

const mockBots: Bot[] = [
  makeMockBot({
    id: "bot-chief",
    name: "Chief",
    title: "Orchestrator",
    description: "Team Lead",
    modelProvider: "anthropic",
    modelId: "claude-3-7-sonnet",
    color: "blue",
  }),
  makeMockBot({
    id: "bot-scout",
    name: "Scout",
    title: "Market Researcher",
    description: "Scouting agent",
    modelProvider: "openai",
    modelId: "gpt-4o",
    color: "emerald",
  }),
];

const mockSkills: AgentSkillCatalogEntry[] = [
  {
    id: "builtin:daily-standup",
    name: "Daily standup",
    description: "Generate structured standup notes",
    content: "---\nname: Daily standup\ndescription: Generate structured standup notes\n---\nBody",
    source: "builtin",
    readOnly: true,
  },
  {
    id: "custom-1",
    name: "Market Research",
    description: "Deep dive competitor analysis",
    content:
      "---\nname: Market Research\ndescription: Deep dive competitor analysis\nbots: [Scout]\n---\nBody",
    source: "user",
    readOnly: false,
  },
];

describe("SkillsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.resetAllMocks();
    skillsApi.listSkills.mockResolvedValue(mockSkills);
    skillsApi.getSkill.mockImplementation(async ({ skillId }: { skillId: string }) => {
      const found = mockSkills.find((s) => s.id === skillId);
      return found ?? mockSkills[1];
    });
    skillsApi.listBots.mockResolvedValue(mockBots);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderComponent() {
    await act(async () => {
      root.render(<SkillsTab />);
    });
  }

  it("renders skills list and marks built-in skills as read-only without Bot Scope trigger", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Daily standup");
    expect(container.textContent).toContain("Market Research");

    // "Bot Scope" configuration button only appears for user-editable skill
    const scopeButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Bot Scope"),
    );
    expect(scopeButtons.length).toBe(1);
  });

  it("displays bot scope badges accurately from frontmatter content", async () => {
    await renderComponent();

    // Market Research has bots: [Scout], so Scout is resolved and displayed
    expect(container.textContent).toContain("Scout");
  });

  it("opens Bot Scope modal and prevents saving when specific bots is selected with no bots checked", async () => {
    await renderComponent();

    const scopeButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bot Scope"),
    );
    expect(scopeButton).toBeDefined();

    await act(async () => {
      scopeButton?.click();
    });

    expect(container.textContent).toContain("Configure Bot Scope: Market Research");

    // Select "Specific Bots Only" radio
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    const specificRadio = radios[1];
    expect(specificRadio).toBeDefined();
    if (!specificRadio) throw new Error("specificRadio not found");

    await act(async () => {
      specificRadio.click();
    });

    // Uncheck any checked bots
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    for (const cb of checkboxes) {
      if (cb.checked) {
        await act(async () => {
          cb.click();
        });
      }
    }

    // Save Scope button should be disabled when specific bots is active but no bots are checked
    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save Scope"),
    );
    expect(saveButton?.disabled).toBe(true);
  });

  it("saves updated bot scope when authorized bots are selected", async () => {
    skillsApi.updateSkill.mockResolvedValue({ id: "custom-1", ok: true });
    await renderComponent();

    const scopeButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bot Scope"),
    );

    await act(async () => {
      scopeButton?.click();
    });

    // Select Chief bot checkbox
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    const chiefCheckbox = checkboxes[0];
    expect(chiefCheckbox).toBeDefined();
    if (!chiefCheckbox) throw new Error("chiefCheckbox not found");
    if (!chiefCheckbox.checked) {
      await act(async () => {
        chiefCheckbox.click();
      });
    }

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save Scope"),
    );
    expect(saveButton?.disabled).toBe(false);

    await act(async () => {
      saveButton?.click();
    });

    expect(skillsApi.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "custom-1",
        content: expect.stringContaining("bots:"),
      }),
    );
  });
  function button(text: string) {
    const found = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === text,
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }

  it("rejects stale recipe writes and keeps the error and draft inside the editor", async () => {
    skillsApi.updateSkill.mockRejectedValue(
      new Error("Skill changed while editing. Reopen it and try again."),
    );
    await renderComponent();
    await act(async () => {
      button("Edit").click();
    });
    const original = container.querySelector("textarea")?.value;
    await act(async () => {
      button("Save Skill").click();
    });
    expect(skillsApi.updateSkill).toHaveBeenCalledWith({
      skillId: "custom-1",
      content: original,
      expectedContent: original,
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
      "Skill changed while editing",
    );
    expect(dialog?.querySelector("textarea")?.value).toBe(original);
  });

  it("shows deletion and installation failures inside their open dialogs", async () => {
    skillsApi.deleteSkill.mockRejectedValue(new Error("Could not delete skill"));
    skillsApi.createSkill.mockRejectedValue(new Error("Could not install skill"));
    await renderComponent();
    await act(async () => {
      button("Edit").click();
    });
    await act(async () => {
      button("Delete Skill").click();
    });
    await act(async () => {
      button("Confirm").click();
    });
    expect(skillsApi.deleteSkill).toHaveBeenCalledWith({ skillId: "custom-1" });
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      "Could not delete skill",
    );
    await act(async () => {
      button("Cancel").click();
    });
    // Cancel the delete confirmation first, then close the recipe editor.
    await act(async () => {
      button("Cancel").click();
    });
    await act(async () => {
      button("Marketplace Hub").click();
    });
    const install = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Install Skill",
    );
    await act(async () => {
      install?.click();
    });
    await act(async () => {
      button("Confirm Install").click();
    });
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      "Could not install skill",
    );
  });

  it("ignores older directory searches and clears prior results when the latest has no skills", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    await renderComponent();
    await act(async () => {
      button("Marketplace Hub").click();
    });
    const directory = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("SkillsMP Directory"),
    );
    await act(async () => {
      directory?.click();
    });
    const search = container.querySelector<HTMLInputElement>(
      'input[placeholder^="Search 3,000,000"]',
    );
    if (!search) throw new Error("Missing directory search");
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(pending).toHaveLength(2);
    const result = (name: string) =>
      Response.json({
        data: {
          skills: [
            {
              id: name,
              name,
              author: "Demo",
              description: "Recipe",
              githubUrl: "https://github.com/example/recipes",
              skillUrl: "https://skillsmp.com/skills/demo",
            },
          ],
        },
      });
    await act(async () => {
      pending[1]?.(result("Newest recipe"));
    });
    await act(async () => {
      pending[0]?.(result("Older recipe"));
    });
    expect(container.textContent).toContain("Newest recipe");
    expect(container.textContent).not.toContain("Older recipe");
    await act(async () => {
      button("Search SkillsMP").click();
    });
    await act(async () => {
      pending[2]?.(Response.json({ success: true }));
    });
    expect(container.textContent).not.toContain("Newest recipe");
    expect(container.textContent).toContain("No skills found");
  });
});
