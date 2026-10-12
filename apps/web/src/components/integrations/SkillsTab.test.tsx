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
      delete: skillsApi.deleteSkill,
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
    BotAvatar: ({ identity }: { identity: string }) => <span data-testid={`bot-avatar-${identity}`} />,
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
    Skeleton: ({ className }: { className?: string }) => <div className={className} />,
  };
});

import { SkillsTab } from "./SkillsTab";

const mockBots: Bot[] = [
  {
    id: "bot-chief",
    spaceId: "space-1",
    name: "Chief",
    title: "Orchestrator",
    description: "Team Lead",
    systemPrompt: "",
    modelProvider: "anthropic",
    modelName: "claude-3-7-sonnet",
    color: "blue",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "bot-scout",
    spaceId: "space-1",
    name: "Scout",
    title: "Market Researcher",
    description: "Scouting agent",
    systemPrompt: "",
    modelProvider: "openai",
    modelName: "gpt-4o",
    color: "emerald",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
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
    content: "---\nname: Market Research\ndescription: Deep dive competitor analysis\nbots: [Scout]\n---\nBody",
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
    vi.clearAllMocks();
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
    const scopeButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Bot Scope"),
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

    const scopeButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Bot Scope"),
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

    await act(async () => {
      specificRadio.click();
    });

    // Uncheck any checked bots
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      if (cb.checked) {
        await act(async () => {
          cb.click();
        });
      }
    }

    // Save Scope button should be disabled when specific bots is active but no bots are checked
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Save Scope"),
    );
    expect(saveButton?.disabled).toBe(true);
  });

  it("saves updated bot scope when authorized bots are selected", async () => {
    skillsApi.updateSkill.mockResolvedValue({ id: "custom-1", ok: true });
    await renderComponent();

    const scopeButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Bot Scope"),
    );

    await act(async () => {
      scopeButton?.click();
    });

    // Select Chief bot checkbox
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const chiefCheckbox = checkboxes[0];
    if (!chiefCheckbox.checked) {
      await act(async () => {
        chiefCheckbox.click();
      });
    }

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Save Scope"),
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
});
