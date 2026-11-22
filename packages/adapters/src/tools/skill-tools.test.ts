import { buildSkillMd, formatSkillsCatalogInstruction, parseSkillMd } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.prompt.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";

type Scope = {
  spaceId?: string;
  userId?: string;
  name?: { equals: string } | string;
  NOT?: { id: string };
  OR?: Array<{ spaceId?: string; allSpaces?: boolean }>;
};
/** The owner's rows here: added in this space or available in all of the owner's spaces. */
function inScope(row: Record<string, unknown>, where: Scope): boolean {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.spaceId && row.spaceId !== where.spaceId) return false;
  if (
    typeof where.name === "object" &&
    String(row.name).toLowerCase() !== where.name.equals.toLowerCase()
  )
    return false;
  if (where.NOT && row.id === where.NOT.id) return false;
  if (
    where.OR &&
    !where.OR.some(
      (branch) => branch.spaceId === row.spaceId || (branch.allSpaces && row.allSpaces === true),
    )
  )
    return false;
  return true;
}

function makePrisma(
  rows: Array<Record<string, unknown>> = [],
  routines: Array<{ id: string; userId: string; spaceId: string; prompt: string }> = [],
) {
  const store = [...rows];
  const client = {
    agentSkill: {
      findMany: vi.fn(async ({ where }: { where?: Scope } = {}) =>
        store.filter((row) => !where || inScope(row, where)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Scope & { id: string } }) => {
        const row = store.find((item) => item.id === where.id && inScope(item, where));
        return row
          ? {
              ...row,
              files: row.files ?? null,
              spaceId: row.spaceId,
              allSpaces: row.allSpaces === true,
              availableIn: [],
            }
          : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `skill-${store.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "user",
          ...data,
        };
        store.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = store.findIndex((row) => row.id === where.id);
          if (index < 0) throw new Error("missing");
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return store[index];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Scope & Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const index = store.findIndex(
            (row) =>
              row.id === where.id &&
              inScope(row, where) &&
              row.source === where.source &&
              (where.name === undefined || row.name === where.name),
          );
          if (index < 0) return { count: 0 };
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return { count: 1 };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = store.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error("missing");
        const [removed] = store.splice(index, 1);
        return removed;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Scope & Record<string, unknown> }) => {
        const index = store.findIndex(
          (row) => row.id === where.id && inScope(row, where) && row.source === where.source,
        );
        if (index < 0) return { count: 0 };
        store.splice(index, 1);
        return { count: 1 };
      }),
    },
    routine: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; spaceId?: { in: string[] } } }) =>
          routines.filter(
            (row) =>
              row.userId === where.userId &&
              (!where.spaceId || where.spaceId.in.includes(row.spaceId)) &&
              row.prompt.includes("@"),
          ),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; prompt: string }; data: object }) => {
          const row = routines.find((r) => r.id === where.id && r.prompt === where.prompt);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ bypass: null, key: null, login: "test" }]),
    _store: store,
    _routines: routines,
  };
  return Object.assign(client, {
    $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => run(client)),
  });
}

const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  it("describes the skill tools without naming a vendor, runtime or how skills are stored", () => {
    const skillTools = builtinAgentTools.filter((tool) => tool.name.startsWith("skill_"));
    expect(skillTools.map((tool) => tool.name).sort()).toEqual([
      "skill_create",
      "skill_delete",
      "skill_read",
      "skill_update",
    ]);
    for (const tool of skillTools) {
      expect(tool.description).not.toMatch(
        /claude|anthropic|\bpi\b|runtime|SKILL\.md|persist|inject/i,
      );
    }
  });

  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("creates, reads, updates, and deletes user skills", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "1. Summarize yesterday.\n2. List blockers.",
    });
    expect(created).toMatchObject({ ok: true, name: "Daily standup" });
    expect(String(created.hint)).toContain("/Daily standup");

    const read = await skillReadFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(read).toMatchObject({
      name: "Daily standup",
      description: "Prepare standup notes",
      readOnly: false,
    });
    expect(String(read.content)).toContain("Summarize yesterday");

    const updated = await skillUpdateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Updated when-to-use",
    });
    expect(updated).toMatchObject({ ok: true, description: "Updated when-to-use" });

    const deleted = await skillDeleteFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(deleted).toEqual({ ok: true, name: "Daily standup" });
    expect(await skillReadFromTool(prisma as never, owner, { name: "Daily standup" })).toEqual({
      error: "Skill not found.",
    });
  });

  it("lists a skill's reference files and reads one by exact path only", async () => {
    const prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "billing",
        description: "Billing guidance",
        content: buildSkillMd({
          name: "billing",
          description: "Billing guidance",
          body: "See references/rates.md.",
        }),
        source: "plugin",
        files: { "references/rates.md": "Rates table", "notes.txt": "Notes" },
      },
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "billing" })).toMatchObject({
      name: "billing",
      files: ["notes.txt", "references/rates.md"],
    });
    expect(prisma.agentSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, name: true } }),
    );
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "plugin-1",
          name: "billing",
          userId: owner.userId,
          OR: [
            { spaceId: owner.spaceId },
            { allSpaces: true },
            { availableIn: { some: { spaceId: owner.spaceId } } },
          ],
        },
      }),
    );
    expect(
      await skillReadFromTool(prisma as never, owner, {
        name: "billing",
        file: "./references/rates.md",
      }),
    ).toEqual({ name: "billing", file: "references/rates.md", content: "Rates table" });
    expect(
      await skillReadFromTool(prisma as never, owner, { name: "billing", file: "../secrets.md" }),
    ).toMatchObject({ error: expect.stringContaining("No file") });

    // Visibility can change between matching a name and fetching the document.
    prisma.agentSkill.findFirst.mockResolvedValueOnce(null);
    expect(await skillReadFromTool(prisma as never, owner, { name: "billing" })).toEqual({
      error: "Skill not found.",
    });
  });

  it("preserves extra frontmatter keys on update", async () => {
    const content = buildSkillMd({
      name: "Review PR",
      description: "Review a pull request",
      body: "1. Read the diff.",
      frontmatter: { compatibility: "cursor", "allowed-tools": ["shell"] },
    });
    await skillCreateFromTool(prisma as never, owner, { content });
    await skillUpdateFromTool(prisma as never, owner, {
      name: "Review PR",
      body: "1. Read the diff.\n2. Leave comments.",
    });
    const read = await skillReadFromTool(prisma as never, owner, { name: "Review PR" });
    expect(String(read.content)).toContain("compatibility: cursor");
    expect(String(read.content)).toContain("Leave comments");
  });

  it("renames only via newName, not the name lookup key", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Original",
      description: "Keep name unless newName",
      body: "body",
    });
    const skillId = String(created.id);
    const mistyped = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      name: "Should not apply",
      description: "still original name",
    });
    expect(mistyped).toMatchObject({ ok: true, name: "Original" });

    const renamed = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      newName: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, name: "Renamed" });
  });

  it("points routines that mention a renamed skill at its new name", async () => {
    const routine = (id: string, userId: string, spaceId: string, prompt: string) => ({
      id,
      userId,
      spaceId,
      prompt,
    });
    prisma = makePrisma(
      [],
      [
        routine("r1", "user-1", "ws-1", "Run @Original, then @Original tools."),
        routine("r2", "user-1", "ws-2", "Run @Original here."),
        routine("r3", "user-2", "ws-1", "Run @Original here."),
      ],
    );
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Original",
      description: "d",
      body: "body",
    });
    await skillCreateFromTool(prisma as never, owner, {
      name: "Original tools",
      description: "d",
      body: "body",
    });
    const publishSpaceChange = vi.fn(async () => undefined);
    await skillUpdateFromTool(
      prisma as never,
      owner,
      { skillId: String(created.id), newName: "Renamed" },
      { publishSpaceChange },
    );
    expect(publishSpaceChange.mock.calls).toEqual([["ws-1", "routines"]]);
    expect(prisma._routines.map((row) => row.prompt)).toEqual([
      "Run @Renamed, then @Original tools.",
      "Run @Original here.",
      "Run @Original here.",
    ]);
  });

  it("edits and deletes the owner's skills that other spaces also use", async () => {
    prisma = makePrisma(
      [
        {
          id: "shared",
          spaceId: "ws-2",
          userId: "user-1",
          allSpaces: true,
          name: "Shared",
          description: "d",
          content: buildSkillMd({ name: "Shared", description: "d", body: "old" }),
          source: "user",
        },
      ],
      [
        { id: "r1", userId: "user-1", spaceId: "ws-1", prompt: "Run @Shared." },
        { id: "r2", userId: "user-1", spaceId: "ws-3", prompt: "Run @Shared." },
      ],
    );
    const publishSpaceChange = vi.fn(async () => undefined);
    const updated = await skillUpdateFromTool(
      prisma as never,
      owner,
      { name: "Shared", newName: "Better", body: "new" },
      { publishSpaceChange },
    );
    expect(updated).toMatchObject({ ok: true, name: "Better" });
    expect(prisma._store[0]?.content).toContain("new");
    expect(prisma._routines.map((row) => row.prompt)).toEqual(["Run @Better.", "Run @Better."]);
    expect(publishSpaceChange.mock.calls).toEqual([
      ["ws-1", "routines"],
      ["ws-3", "routines"],
    ]);

    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Better" })).toMatchObject({
      ok: true,
    });
    expect(prisma._store).toHaveLength(0);
  });

  it("refuses a rename that would clash with a skill in another space it reaches", async () => {
    const skill = (id: string, spaceId: string, name: string, allSpaces: boolean) => ({
      id,
      spaceId,
      userId: "user-1",
      allSpaces,
      name,
      description: "d",
      content: buildSkillMd({ name, description: "d", body: "b" }),
      source: "user",
    });
    prisma = makePrisma([
      skill("shared", "ws-1", "Shared", true),
      skill("local", "ws-2", "Taken", false),
    ]);
    const result = await skillUpdateFromTool(prisma as never, owner, {
      name: "Shared",
      newName: "Taken",
    });
    expect(result).toEqual({
      error: "A skill with that name already exists in one of these spaces.",
    });
    expect(prisma._store[0]?.name).toBe("Shared");
  });

  it("leaves routines alone when another rename got there first", async () => {
    prisma = makePrisma([], [{ id: "r1", userId: "user-1", spaceId: "ws-1", prompt: "@Old" }]);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Old",
      description: "d",
      body: "body",
    });
    const publishSpaceChange = vi.fn(async () => undefined);
    // The skill was renamed between this tool's read and its write.
    const [stored] = (await prisma.agentSkill.findMany()) as Array<{ id: string }>;
    await prisma.agentSkill.update({ where: { id: String(stored?.id) }, data: { name: "Other" } });
    prisma.agentSkill.findMany.mockResolvedValueOnce([{ ...stored, name: "Old" }]);
    const result = await skillUpdateFromTool(
      prisma as never,
      owner,
      { skillId: String(created.id), newName: "New" },
      { publishSpaceChange },
    );
    expect(result).toHaveProperty("error");
    expect(prisma._routines[0]?.prompt).toBe("@Old");
    expect(publishSpaceChange).not.toHaveBeenCalled();
  });

  it("leaves routines alone when the skill keeps its name", async () => {
    prisma = makePrisma([], [{ id: "r1", userId: "user-1", spaceId: "ws-1", prompt: "@Keep" }]);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Keep",
      description: "d",
      body: "body",
    });
    await skillUpdateFromTool(prisma as never, owner, {
      skillId: String(created.id),
      description: "new",
    });
    expect(prisma.routine.updateMany).not.toHaveBeenCalled();
  });

  it("scopes list to the owner workspace and injects catalog lines", async () => {
    prisma = makePrisma([
      {
        id: "other-1",
        spaceId: "ws-2",
        userId: "user-2",
        name: "Other workspace skill",
        description: "not visible",
        content: buildSkillMd({
          name: "Other workspace skill",
          description: "not visible",
          body: "x",
        }),
        source: "user",
      },
    ]);
    await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "steps",
    });
    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.map((row) => row.name)).toContain("Daily standup");
    expect(records.map((row) => row.name)).not.toContain("Other workspace skill");
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("- Daily standup: Prepare standup notes");
    expect(catalog).toContain("skill_read");
  });

  it("rejects update/delete for plugin and builtin skills", async () => {
    prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Plugin recipe",
        description: "From a plugin",
        content: buildSkillMd({
          name: "Plugin recipe",
          description: "From a plugin",
          body: "do not edit",
        }),
        source: "plugin",
      },
    ]);
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Plugin recipe",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Plugin recipe" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it("ships builtin skills as valid, readable, read-only SKILL.md records", async () => {
    expect(BUILTIN_AGENT_SKILLS.map((skill) => skill.name)).toContain("Interrogate");
    for (const skill of BUILTIN_AGENT_SKILLS) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed).toMatchObject({ name: skill.name, description: skill.description });
      // / picker truncates at 72; keep descriptions short so "review only" stays visible.
      expect(skill.description.length).toBeLessThanOrEqual(72);
    }

    const records = await listAgentSkillRecords(prisma as never, owner);
    const interrogate = records.find((row) => row.name === "Interrogate");
    expect(interrogate).toMatchObject({
      id: "builtin:Interrogate",
      source: "builtin",
      readOnly: true,
    });
    expect(formatSkillsCatalogInstruction(records)).toContain("- Interrogate:");
    expect(formatSkillsCatalogInstruction(records)).toContain("Review only");

    const read = await skillReadFromTool(prisma as never, owner, { name: "interrogate" });
    expect(read).toMatchObject({ name: "Interrogate", source: "builtin", readOnly: true });
    expect(String(read.content)).toContain("Do not modify files");

    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: "interrogate",
        description: "shadow the builtin",
        body: "steps",
      }),
    ).toEqual({ error: 'A skill named "Interrogate" already exists.' });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it.each(["interrogate", " Interrogate "])("preserves a saved skill named %j", async (name) => {
    prisma = makePrisma([
      {
        id: "legacy-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description: "my review recipe",
        content: buildSkillMd({
          name,
          description: "my review recipe",
          body: "my steps",
        }),
        source: "user",
      },
    ]);

    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.filter((skill) => skill.name.trim().toLowerCase() === "interrogate")).toEqual([
      expect.objectContaining({ id: "legacy-1", source: "user", readOnly: false }),
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "Interrogate" })).toMatchObject({
      name,
      source: "user",
      readOnly: false,
    });
    expect(await skillReadFromTool(prisma as never, owner, { skillId: "legacy-1" })).toMatchObject({
      name,
      source: "user",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "still mine",
      }),
    ).toMatchObject({ ok: true });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      ok: true,
      name: name.trim(),
    });
  });

  it("rejects oversized skill content", async () => {
    const body = "x".repeat(100_001);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Huge",
      description: "too big",
      body,
    });
    expect(created).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("rejects overlong skill names on structured create and rename", async () => {
    const longName = "N".repeat(81);
    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: longName,
        description: "ok description",
        body: "steps",
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });

    await skillCreateFromTool(prisma as never, owner, {
      name: "Short",
      description: "ok description",
      body: "steps",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Short",
        newName: longName,
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });
  });
});
