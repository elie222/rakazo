import { skillReadFromTool } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { appHandler, handle } from "../router-test-support.js";
import { createAgentSkillsService, resolveSkillContent } from "./agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function savedSkill(name: string, source = "user", files: Prisma.JsonValue = null) {
  return {
    id: "saved-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name,
    description: "Saved review recipe",
    content: buildSkillMd({ name, description: "Saved review recipe", body: "Saved steps" }),
    source,
    files,
    allSpaces: false,
    availableIn: [] as { spaceId: string }[],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

type SavedSkillRow = ReturnType<typeof savedSkill>;

function setup(rows: SavedSkillRow[] = []) {
  type Where = Prisma.AgentSkillWhereInput;
  const matches = (row: SavedSkillRow, where: Where): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR") {
        return where.OR?.some((branch) => matches(row, branch)) ?? false;
      }
      if (key === "availableIn") {
        return row.availableIn.some((entry) => entry.spaceId === where.availableIn?.some?.spaceId);
      }
      if (key === "files") {
        const expected = where.files?.equals;
        return expected === Prisma.AnyNull
          ? row.files === null
          : JSON.stringify(row.files) === JSON.stringify(expected);
      }
      return row[key as keyof typeof row] === value;
    });
  const agentSkill = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const row = rows.find((row) => matches(row, where));
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: object }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
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
  const prisma = { agentSkill, $transaction } as unknown as PrismaClient;
  const publishSpaceChange = vi.fn(async () => undefined);
  return {
    agentSkill,
    prisma,
    routines,
    queryRaw: tx.$queryRaw,
    publishSpaceChange,
    service: createAgentSkillsService(prisma, { publishSpaceChange }),
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

describe("personal skill attachments", () => {
  const skillId = "saved-1";
  const file = { path: "references/example.md", content: "Fictitious checklist.\n" };

  async function rpc(
    prisma: PrismaClient,
    path: string,
    input: unknown,
    caller: Actor | null = actor,
  ) {
    const response = await handle(
      appHandler({ prisma, env: {}, dataDir: "/tmp" } as RouterDeps),
      new Request(`http://127.0.0.1/rpc/agentSkills/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response.status, json: (await response.json()).json };
  }

  it("adds and replaces one file through the update RPC and only reads it by its path", async () => {
    const row = {
      ...savedSkill("Review", "user", { "references/keep.txt": "Keep this." }),
      content:
        "---\r\nname: Review\r\ndescription: Saved review recipe\r\nextra: keep\r\n---\r\n\r\nSaved steps\r\n",
    };
    const { prisma } = setup([row]);
    const before = await rpc(prisma, "get", { skillId });
    const saved = await rpc(prisma, "update", { skillId, file });
    expect(saved).toEqual({
      status: 200,
      json: { ...before.json, updatedAt: "1970-01-01T00:00:00.001Z" },
    });
    expect(await rpc(prisma, "get", { skillId })).toEqual(saved);
    const catalog = await rpc(prisma, "list", undefined);
    expect(catalog.status).toBe(200);
    expect(catalog.json.find((skill: { id: string }) => skill.id === skillId)).toEqual({
      id: skillId,
      name: "Review",
      description: "Saved review recipe",
      source: "user",
      readOnly: false,
      availability: { allSpaces: false, spaceIds: [actor.spaceId] },
    });
    const read = (path?: string) =>
      skillReadFromTool(prisma, actor, { name: "Review", file: path });
    expect(await read()).toMatchObject({ files: [file.path, "references/keep.txt"].sort() });
    expect(await read(file.path)).toEqual({
      name: "Review",
      file: file.path,
      content: file.content,
    });
    const changed = { ...file, content: "Revised checklist." };
    const replaced = await rpc(prisma, "update", { skillId, file: changed });
    expect(replaced.status).toBe(200);
    expect(await rpc(prisma, "update", { skillId, file: changed })).toEqual(replaced);
    expect(await read(file.path)).toMatchObject({ content: changed.content });
    expect(await read("references/keep.txt")).toMatchObject({ content: "Keep this." });
    const oldClient = await rpc(prisma, "update", { skillId, body: "Updated steps" });
    expect(oldClient.status).toBe(200);
    expect(oldClient.json.content).toContain("Updated steps");
    expect(await read(file.path)).toMatchObject({ content: changed.content });
  });

  it.each([
    { userId: "other-user", allSpaces: true },
    { spaceId: "other-space" },
    { source: "plugin" },
    { source: "builtin" },
    { source: "unknown" },
  ])("refuses to attach a file to an inaccessible or read-only skill %j", async (overrides) => {
    const row = { ...savedSkill("Review"), ...overrides };
    const { prisma } = setup([row]);
    expect((await rpc(prisma, "update", { skillId, file })).status).toBe(
      overrides.source ? 400 : 404,
    );
    expect(row.files).toBeNull();
  });

  it.each([{ allSpaces: true }, { availableIn: [{ spaceId: actor.spaceId }] }])(
    "allows the owner to update a skill available from another Space %j",
    async (availability) => {
      const row = { ...savedSkill("Review"), spaceId: "other-space", ...availability };
      const { prisma } = setup([row]);
      expect((await rpc(prisma, "update", { skillId, file })).status).toBe(200);
      expect(await skillReadFromTool(prisma, actor, { skillId, file: file.path })).toMatchObject({
        content: file.content,
      });
    },
  );

  it("requires the existing signed-in user session", async () => {
    const row = savedSkill("Review");
    const { prisma } = setup([row]);
    expect((await rpc(prisma, "update", { skillId, file }, null)).status).toBe(401);
    expect(row.files).toBeNull();
  });

  it.each([
    "/absolute.md",
    "C:/absolute.md",
    "references/../escape.md",
    "references//example.md",
    "./example.md",
    "references\\example.md",
    "references/%2e%2e/example.md",
    "references/example.md ",
    "references/example.md\n",
    "SKILL.md",
    "__proto__",
    "constructor",
    "x".repeat(241),
  ])("rejects invalid path %j at the RPC boundary", async (path) => {
    const row = savedSkill("Review");
    const { prisma } = setup([row]);
    expect((await rpc(prisma, "update", { skillId, file: { ...file, path } })).status).toBe(400);
    expect(row.files).toBeNull();
  });

  it.each([
    ["a NUL byte", "valid-looking\0text"],
    ["a C1 control", "valid-looking\u0085text"],
    ["an unpaired surrogate", "valid-looking\uD800text"],
    ["more than 100000 UTF-8 bytes", "é".repeat(50_001)],
    ["a non-string payload", [80, 75, 0]],
  ])("rejects %s in a text attachment", async (_, content) => {
    const row = savedSkill("Review");
    const { prisma } = setup([row]);
    expect((await rpc(prisma, "update", { skillId, file: { ...file, content } })).status).toBe(400);
    expect(row.files).toBeNull();
  });

  it("validates writes made directly through the service", async () => {
    const row = savedSkill("Review");
    const { service } = setup([row]);
    await expect(
      service.update(actor, { skillId, file: { ...file, path: "../outside.md" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(row.files).toBeNull();
  });

  it("rejects mixing the file write with a skill document edit", async () => {
    const row = savedSkill("Review");
    const { prisma } = setup([row]);
    expect((await rpc(prisma, "update", { skillId, file, body: "Changed" })).status).toBe(400);
    expect(row.files).toBeNull();
    expect(row.content).toContain("Saved steps");
  });

  it.each([
    {
      limit: "count",
      files: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`note-${index}.txt`, ""]),
      ),
    },
    {
      limit: "bytes",
      files: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [`note-${index}.txt`, "é".repeat(50_000)]),
      ),
    },
  ])(
    "enforces the aggregate $limit limit and allows replacements within budget",
    async ({ files }) => {
      const row = savedSkill("Review", "user", files);
      const { prisma } = setup([row]);
      expect((await rpc(prisma, "update", { skillId, file })).status).toBe(400);
      expect(row.files).toEqual(files);
      const replacement = { path: "note-0.txt", content: "" };
      expect((await rpc(prisma, "update", { skillId, file: replacement })).status).toBe(200);
      expect(row.files).toEqual({ ...files, "note-0.txt": "" });
    },
  );

  it("preserves other attachments and a document edit when writes overlap", async () => {
    const row = savedSkill("Review");
    const { service, prisma } = setup([row]);
    const secondFile = { path: "example", content: "Second\r\nexample\ttext 🌱" };
    await Promise.all([
      service.update(actor, { skillId, file }),
      service.update(actor, { skillId, file: secondFile }),
      service.update(actor, { skillId, description: "Edited at the same time", body: "New steps" }),
    ]);
    expect(row.description).toBe("Edited at the same time");
    expect(row.content).toContain("New steps");
    for (const expected of [file, secondFile]) {
      expect(
        await skillReadFromTool(prisma, actor, { skillId, file: expected.path }),
      ).toMatchObject({
        content: expected.content,
      });
    }
  });

  it("rechecks the file count after another writer fills the last slot", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 39 }, (_, index) => [`note-${index}.txt`, ""]),
    );
    const row = savedSkill("Review", "user", files);
    const { service } = setup([row]);
    const otherFile = { ...file, path: "references/other.md" };
    const results = await Promise.allSettled([
      service.update(actor, { skillId, file }),
      service.update(actor, { skillId, file: otherFile }),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "fulfilled" }),
        { status: "rejected", reason: expect.objectContaining({ code: "BAD_REQUEST" }) },
      ]),
    );
    const winner = results[0].status === "fulfilled" ? file : otherFile;
    expect(row.files).toEqual({ ...files, [winner.path]: winner.content });
  });

  it("refuses to overwrite an imported attachment map with an invalid stored shape", async () => {
    const files = { "legacy.md": "Kept", "unknown.json": { value: "Kept too" } };
    const row = savedSkill("Review", "user", files);
    const { service } = setup([row]);
    await expect(service.update(actor, { skillId, file })).rejects.toThrow(
      "does not match its schema",
    );
    expect(row.files).toEqual(files);
  });

  it("omits attachment blobs from skill lookups and loads them only for file updates", async () => {
    const row = savedSkill("Review", "user", { "references/notes.md": "Stored" });
    const { agentSkill, service } = setup([row]);

    await service.get(actor, { skillId });
    expect(agentSkill.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ omit: { files: true } }),
    );

    await service.get(actor, { name: "Review" });
    expect(agentSkill.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ omit: { files: true } }),
    );

    agentSkill.findFirst.mockClear();
    await service.update(actor, { skillId, file });
    expect(agentSkill.findFirst).toHaveBeenCalledTimes(2);
    expect(agentSkill.findFirst.mock.calls[0]?.[0]).not.toHaveProperty("omit");
    expect(agentSkill.findFirst.mock.calls[1]?.[0]).toMatchObject({ omit: { files: true } });
  });
});
