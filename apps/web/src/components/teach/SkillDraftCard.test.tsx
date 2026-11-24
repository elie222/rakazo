// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  skills: { updateDraft: vi.fn(), save: vi.fn(), testRun: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({ rpc: rpcMock }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { SkillDraftCard } from "./SkillDraftCard";

const block = {
  kind: "skill_draft" as const,
  skillId: "skill-1",
  name: "Triage inbox",
  goal: "Sort the inbox",
  playbook: {
    whenToUse: "When new mail arrives",
    inputs: ["mail"],
    steps: ["Sort mail"],
    howToCheck: "Count the sorted mail",
    whatToReturn: "A summary",
    approvalBoundaries: "Ask before sending",
    failureHandling: "Stop and report",
  },
  status: "draft" as const,
};

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SkillDraftCard
        block={block}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onAddRoutine={vi.fn()}
      />,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonNamed(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no button named ${label}`);
  return found;
}

function alertNode(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[role="alert"]');
}

async function click(button: HTMLElement) {
  await act(async () => button.click());
}

it("announces a failed save as an alert", async () => {
  rpcMock.skills.updateDraft.mockRejectedValue(new Error("Skill name is already taken"));
  const view = await render();

  await click(buttonNamed(view.container, "Save"));

  await vi.waitFor(() =>
    expect(alertNode(view.container)?.textContent).toBe("Skill name is already taken"),
  );
  await view.cleanup();
});

it("announces a failed test run as an alert", async () => {
  rpcMock.skills.updateDraft.mockResolvedValue({});
  rpcMock.skills.testRun.mockRejectedValue(new Error("Test run could not start"));
  const view = await render();

  await click(buttonNamed(view.container, "Test"));

  await vi.waitFor(() =>
    expect(alertNode(view.container)?.textContent).toBe("Test run could not start"),
  );
  await view.cleanup();
});

it("announces a retry that fails again as a new alert", async () => {
  rpcMock.skills.updateDraft.mockRejectedValue(new Error("Skill name is already taken"));
  const view = await render();

  await click(buttonNamed(view.container, "Save"));
  await vi.waitFor(() => expect(alertNode(view.container)).not.toBeNull());
  const first = alertNode(view.container);

  await click(buttonNamed(view.container, "Save"));
  await vi.waitFor(() => {
    const second = alertNode(view.container);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
  expect(rpcMock.skills.updateDraft).toHaveBeenCalledTimes(2);
  await view.cleanup();
});

it("announces no error after a successful save", async () => {
  rpcMock.skills.updateDraft.mockResolvedValue({});
  rpcMock.skills.save.mockResolvedValue({});
  const view = await render();

  await click(buttonNamed(view.container, "Save"));

  await vi.waitFor(() => expect(buttonNamed(view.container, "Saved")).not.toBeNull());
  expect(alertNode(view.container)).toBeNull();
  await view.cleanup();
});
