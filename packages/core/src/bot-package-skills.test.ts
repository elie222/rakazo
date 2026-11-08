import type { BotPackageReceipt, BotPackageSkillReceipt } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deferred, packageReceipt } from "./bot-package.test-helpers.js";
import type { BotPackageSkillsState } from "./bot-package-skills.js";
import { createBotPackageSkills, initialBotPackageSkills } from "./bot-package-skills.js";

const skill: BotPackageSkillReceipt = {
  id: "component-1",
  key: "skill-1",
  name: "research",
  description: "Research a topic",
  content: "---\nname: research\ndescription: Research a topic\n---\nKeep sources.\n",
  status: "pending",
  revision: 1,
  skillId: null,
};
const pending = () => packageReceipt({ skills: [skill] });
const activated = () =>
  packageReceipt({
    revision: 2,
    skills: [{ ...skill, status: "activated", revision: 2, skillId: "shared-skill-1" }],
  });

function fixture() {
  type Deps = Parameters<typeof createBotPackageSkills>[0];
  let state = initialBotPackageSkills;
  let epoch = 1;
  const changes: BotPackageSkillsState[] = [];
  const deps = {
    botId: "bot-1",
    forBot: vi.fn<Deps["forBot"]>(async () => pending()),
    activateSkill: vi.fn<Deps["activateSkill"]>(async () => activated()),
    isCurrent: () => epoch === 1,
    changed(next: BotPackageSkillsState) {
      state = next;
      changes.push(next);
    },
  };
  const manager = createBotPackageSkills(deps);
  return {
    manager,
    deps,
    changes,
    get state() {
      return state;
    },
    switchScope() {
      epoch++;
    },
  };
}

describe("pending package skills", () => {
  it("loads without activating and uses the current component revision for an explicit rename", async () => {
    const f = fixture();
    await f.manager.refresh();
    expect(f.deps.activateSkill).not.toHaveBeenCalled();
    await f.manager.activate("component-1", "renamed-research");
    expect(f.deps.activateSkill).toHaveBeenCalledExactlyOnceWith(
      { componentId: "component-1", expectedRevision: 1, name: "renamed-research" },
      expect.any(AbortSignal),
    );
    expect(f.state.receipt?.skills[0]?.status).toBe("activated");
  });

  it("blocks replay after a lost activation reply until a read succeeds", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.deps.activateSkill.mockRejectedValueOnce(new Error("ack lost"));
    await f.manager.activate("component-1");
    await f.manager.activate("component-1");
    expect(f.state).toMatchObject({ phase: "unknown", unknownComponentId: "component-1" });
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
    f.deps.forBot.mockRejectedValueOnce(new Error("read unavailable"));
    await f.manager.refresh();
    await f.manager.activate("component-1");
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
    f.deps.forBot.mockResolvedValueOnce(activated());
    await f.manager.refresh();
    await f.manager.activate("component-1");
    expect(f.state.phase).toBe("ready");
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
  });

  it("does not automatically retry a still-pending item, then uses its reread revision", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.deps.activateSkill.mockRejectedValueOnce(new Error("ack lost"));
    await f.manager.activate("component-1");
    f.deps.forBot.mockResolvedValueOnce(
      packageReceipt({ revision: 2, skills: [{ ...skill, revision: 2 }] }),
    );
    await f.manager.refresh();
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
    await f.manager.activate("component-1");
    expect(f.deps.activateSkill.mock.calls[1]?.[0].expectedRevision).toBe(2);
  });

  it("retains the known receipt and keeps activation locked on a regressing read", async () => {
    const f = fixture();
    f.deps.forBot.mockResolvedValueOnce(
      packageReceipt({ revision: 2, skills: [{ ...skill, revision: 2 }] }),
    );
    await f.manager.refresh();
    f.deps.activateSkill.mockRejectedValueOnce(new Error("ack lost"));
    await f.manager.activate("component-1");
    await f.manager.refresh();
    await f.manager.activate("component-1");
    expect(f.state.phase).toBe("unknown");
    expect(f.state.receipt?.revision).toBe(2);
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
  });

  it.each(["activated", "removed"] as const)("never reactivates a %s item", async (status) => {
    const f = fixture();
    f.deps.forBot.mockResolvedValueOnce(
      packageReceipt({ skills: [{ ...skill, status, content: null }] }),
    );
    await f.manager.refresh();
    await f.manager.activate("component-1");
    await f.manager.activate("unrelated-component");
    expect(f.deps.activateSkill).not.toHaveBeenCalled();
  });

  it("does not expose a receipt for a different bot", async () => {
    const f = fixture();
    f.deps.forBot.mockResolvedValueOnce(packageReceipt({ botId: "other-bot" }));
    await f.manager.refresh();
    expect(f.state).toMatchObject({ phase: "unknown", receipt: null });
  });

  it("rejects an activation reply belonging to a different import", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.deps.activateSkill.mockResolvedValueOnce(packageReceipt({ importId: "other-import" }));
    await f.manager.activate("component-1");
    expect(f.state).toMatchObject({ phase: "unknown", unknownComponentId: "component-1" });
    expect(f.state.receipt?.importId).toBe("import-1");
  });

  it("deduplicates activation and discards its late reply after scope disposal", async () => {
    const f = fixture();
    const result = deferred<BotPackageReceipt>();
    await f.manager.refresh();
    f.deps.activateSkill.mockImplementationOnce(() => result.promise);
    const saving = f.manager.activate("component-1");
    await f.manager.activate("component-1");
    expect(f.deps.activateSkill).toHaveBeenCalledOnce();
    f.switchScope();
    f.switchScope();
    f.manager.dispose();
    const count = f.changes.length;
    result.resolve(activated());
    await saving;
    expect(f.changes).toHaveLength(count);
  });
});
