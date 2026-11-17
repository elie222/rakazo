import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { listSchedulesFromTool } from "./schedule-tools.js";
import { listScratchpadItems } from "./scratchpad-tools.js";
import { listAgentSkillRecords } from "./skill-tools.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.prompt.js";

export type TaskCatalogToolDeps = {
  prisma: PrismaClient;
};

type TaskCatalogInput = {
  spaceId: string;
  botId: string;
  userId: string;
  /** In a group run, marks which routines post in the group. */
  groupThreadId?: string;
  tools: readonly Pick<ConnectorTool, "name" | "description" | "readOnly">[];
};

export async function taskCatalogFromTool(deps: TaskCatalogToolDeps, input: TaskCatalogInput) {
  const [tasks, schedules, taughtSkills, skills] = await Promise.all([
    listScratchpadItems(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      includeDone: false,
    }),
    listSchedulesFromTool(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      ...(input.groupThreadId ? { groupThreadId: input.groupThreadId } : {}),
    }),
    deps.prisma.taughtSkill.findMany({
      where: {
        spaceId: input.spaceId,
        botId: input.botId,
        status: "saved",
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, name: true, goal: true, status: true },
    }),
    listAgentSkillRecords(deps.prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
    }),
  ]);

  const seenTools = new Set<string>();
  const exposedTools = input.tools.flatMap((tool) => {
    if (seenTools.has(tool.name)) return [];
    seenTools.add(tool.name);
    return [
      {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly ?? false,
      },
    ];
  });

  return {
    guidance: TASK_CATALOG_GUIDANCE,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      notes: task.notes,
      source: "scratchpad",
    })),
    routines: schedules.routines,
    ...(schedules.note ? { routinesNote: schedules.note } : {}),
    taughtSkills: taughtSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      goal: skill.goal,
      status: skill.status,
      source: "taught_skill",
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      readOnly: skill.readOnly,
    })),
    tools: exposedTools,
  };
}
