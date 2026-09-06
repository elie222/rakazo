import type { Actor } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";

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

function setup(rows: ReturnType<typeof savedSkill>[] = []) {
  type Where = { id?: string; spaceId: string; userId: string; source?: string };
  const matches = (row: ReturnType<typeof savedSkill>, where: Where) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value);
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
  return {
    agentSkill,
    service: createAgentSkillsService({ agentSkill } as unknown as PrismaClient),
  };
}

describe("built-in skill precedence in the API", () => {
  it.each(["interrogate", " Interrogate "])(
    "keeps %j listed, readable and mutable",
    async (name) => {
      const { service } = setup([savedSkill(name)]);
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "saved-1", name, readOnly: false }),
      ]);
      await expect(service.listWithContent(actor)).resolves.toEqual([
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
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "builtin:Interrogate" }),
      ]);
      await expect(service.get(actor, { skillId: "saved-1" })).rejects.toThrow();
    },
  );
});
