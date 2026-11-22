import type { Actor } from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService, resolveSkillContent } from "./agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function savedSkill(name: string, source = "user") {
  return {
    id: "saved-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name,
    description: "Saved review recipe",
    content: buildSkillMd({ name, description: "Saved review recipe", body: "Saved steps" }),
    source,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

type SavedSkillRow = ReturnType<typeof savedSkill> & { allSpaces?: boolean };

function setup(rows: SavedSkillRow[] = []) {
  type Where = { id?: string; spaceId?: string; userId: string; source?: string; OR?: object[] };
  const matches = (row: SavedSkillRow, where: object): boolean =>
    Object.entries(where).every(([key, value]) =>
      key === "OR"
        ? (value as object[]).some((branch) => matches(row, branch))
        : row[key as keyof typeof row] === value,
    );
  const agentSkill = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Where }) =>
      rows.find((row) => matches(row, where)),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: object }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const index = rows.findIndex((row) => matches(row, where));
      if (index < 0) return { count: 0 };
      rows.splice(index, 1);
      return { count: 1 };
    }),
  };
  const routines = [
    { id: "r1", userId: actor.userId, spaceId: actor.spaceId, prompt: "Run @Saved review." },
    { id: "r2", userId: actor.userId, spaceId: "space-9", prompt: "Run @Saved review." },
  ];
  const routine = {
    findMany: vi.fn(async ({ where }: { where: { spaceId?: { in: string[] } } }) =>
      routines.filter((row) => !where.spaceId || where.spaceId.in.includes(row.spaceId)),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
      Object.assign(routines.find((row) => row.id === where.id) ?? {}, data);
      return { count: 1 };
    }),
  };
  const tx = {
    agentSkill,
    routine,
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
  };
  const $transaction = vi.fn(async (run: (client: typeof tx) => unknown) => run(tx));
  const publishSpaceChange = vi.fn(async () => undefined);
  return {
    agentSkill,
    routines,
    queryRaw: tx.$queryRaw,
    publishSpaceChange,
    service: createAgentSkillsService({ agentSkill, $transaction } as unknown as PrismaClient, {
      publishSpaceChange,
    }),
  };
}

const interrogates = <T extends { name: string }>(skills: T[]) =>
  skills.filter((skill) => skill.name.trim().toLowerCase() === "interrogate");

describe("built-in skill precedence in the API", () => {
  it.each(["interrogate", " Interrogate "])(
    "keeps %j listed, readable and mutable",
    async (name) => {
      const { service } = setup([savedSkill(name)]);
      expect(interrogates(await service.list(actor))).toEqual([
        expect.objectContaining({ id: "saved-1", name, readOnly: false }),
      ]);
      expect(interrogates(await service.listWithContent(actor))).toEqual([
        expect.objectContaining({ id: "saved-1", content: expect.stringContaining("Saved steps") }),
      ]);
      await expect(service.get(actor, { name: " INTERROGATE " })).resolves.toMatchObject({
        id: "saved-1",
        source: "user",
      });
      await expect(service.get(actor, { skillId: "saved-1" })).resolves.toMatchObject({ name });
      await expect(
        service.update(actor, { skillId: "saved-1", description: "Updated recipe" }),
      ).resolves.toMatchObject({ name: name.trim(), description: "Updated recipe" });
      await expect(service.remove(actor, "saved-1")).resolves.toEqual({ ok: true });
      await expect(service.get(actor, { name: "Interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
    },
  );

  it("preserves plugin precedence and read-only enforcement", async () => {
    const { service, agentSkill } = setup([savedSkill(" Interrogate ", "plugin")]);
    await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
      id: "saved-1",
      source: "plugin",
      readOnly: true,
    });
    await expect(service.update(actor, { skillId: "saved-1", body: "Changed" })).rejects.toThrow(
      "read-only",
    );
    await expect(service.remove(actor, "saved-1")).rejects.toThrow("read-only");
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
    expect(agentSkill.deleteMany).not.toHaveBeenCalled();
  });

  it.each([{ spaceId: "other-space" }, { userId: "other-user" }])(
    "does not let foreign skills shadow the builtin: %j",
    async (foreignOwner) => {
      const { service } = setup([{ ...savedSkill(" Interrogate "), ...foreignOwner }]);
      await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
      expect(interrogates(await service.list(actor))).toEqual([
        expect.objectContaining({ id: "builtin:Interrogate" }),
      ]);
      await expect(service.get(actor, { skillId: "saved-1" })).rejects.toThrow();
    },
  );
});

describe("imported skill content in the API", () => {
  it("keeps multiline keep-chomp metadata editable after normalization", async () => {
    const imported = resolveSkillContent({
      content: `---
name: Release notes
description: Prepare release notes
notes: |+
  First step
  Second step

---

Write the notes.
`,
    });
    const { service } = setup([{ ...savedSkill(imported.name), ...imported }]);

    const updated = await service.update(actor, {
      skillId: "saved-1",
      description: "Prepare weekly release notes",
      body: "Write the weekly notes.",
    });

    const parsed = parseSkillMd(updated.content);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.name).toBe("Release notes");
    expect(parsed.description).toBe("Prepare weekly release notes");
    expect(parsed.body).toBe("Write the weekly notes.");
    expect(parsed.frontmatter.notes).toBe("First step\nSecond step\n\n");
  });
});

describe("renaming a skill", () => {
  it("points the routines that mention it at the new name", async () => {
    const { service, routines, publishSpaceChange } = setup([savedSkill("Saved review")]);
    await service.update(actor, { skillId: "saved-1", name: "Weekly review" });
    expect(routines.map((row) => row.prompt)).toEqual([
      "Run @Weekly review.",
      "Run @Saved review.",
    ]);
    expect(publishSpaceChange.mock.calls).toEqual([[actor.spaceId, "routines"]]);
  });

  it("reaches routines in every space a skill available everywhere is renamed from", async () => {
    const { service, routines, publishSpaceChange, queryRaw } = setup([
      { ...savedSkill("Saved review"), allSpaces: true },
    ]);
    await service.update(actor, { skillId: "saved-1", name: "Weekly review" });
    expect(routines.map((row) => row.prompt)).toEqual([
      "Run @Weekly review.",
      "Run @Weekly review.",
    ]);
    expect(publishSpaceChange.mock.calls).toEqual([
      [actor.spaceId, "routines"],
      ["space-9", "routines"],
    ]);
    // The other space's routines are read by owner, outside this request's Space.
    expect(queryRaw).toHaveBeenCalled();
  });

  it("refuses a rename that lost a race and leaves routines alone", async () => {
    const { service, agentSkill, routines, publishSpaceChange } = setup([
      savedSkill("Saved review"),
    ]);
    agentSkill.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.update(actor, { skillId: "saved-1", name: "Weekly review" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    expect(agentSkill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ name: "Saved review" }) }),
    );
    expect(routines.map((row) => row.prompt)).toEqual(["Run @Saved review.", "Run @Saved review."]);
    expect(publishSpaceChange).not.toHaveBeenCalled();
  });

  it("leaves routines alone when the name is unchanged", async () => {
    const { service, routines, publishSpaceChange } = setup([savedSkill("Saved review")]);
    await service.update(actor, { skillId: "saved-1", description: "Changed" });
    expect(routines.map((row) => row.prompt)).toEqual(["Run @Saved review.", "Run @Saved review."]);
    expect(publishSpaceChange).not.toHaveBeenCalled();
  });
});

describe("skill fields the caller wrote", () => {
  it("refuses an overlong name as the caller's to fix, with the same message", () => {
    expect(() =>
      resolveSkillContent({ name: "N".repeat(81), description: "Review recipe", body: "Steps" }),
    ).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Skill name must be at most 80 characters.",
      }),
    );
  });

  it("lets a fault while building the skill through instead of answering it as a bad request", () => {
    const fault = new Error("internal detail");
    const body = {
      replace: () => {
        throw fault;
      },
    } as unknown as string;
    let thrown: unknown;
    try {
      resolveSkillContent({ name: "Review", description: "Review recipe", body });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(fault);
  });

  it.each(["create", "update"] as const)(
    "answers a name taken during %s as a conflict",
    async (method) => {
      const { service, agentSkill } = setup([savedSkill("Existing")]);
      const taken = Object.assign(new Error("unique"), { code: "P2002" });
      Object.assign(agentSkill, { create: vi.fn().mockRejectedValue(taken) });
      agentSkill.updateMany.mockRejectedValue(taken);
      const input = { name: "Fresh", description: "Review recipe", body: "Steps" };
      await expect(
        method === "create"
          ? service.create(actor, input)
          : service.update(actor, { skillId: "saved-1", ...input }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "A skill with that name already exists.",
      });
    },
  );
});
