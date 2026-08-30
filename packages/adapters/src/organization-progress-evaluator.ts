import { goalEvaluateJob, projectEvaluateJob, type JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export type ProjectProgress = {
  requiredTotal: number;
  completed: number;
  active: number;
  blocked: number;
  failed: number;
  reviewPending: number;
  completionRatio: number;
};

export type GoalProgress = {
  projectsTotal: number;
  projectsCompleted: number;
  projectsActive: number;
  projectsBlocked: number;
  completionRatio: number;
};

/** Deterministic organization progress evaluation; no model is used for state arithmetic. */
export function createOrganizationProgressEvaluator(deps: { prisma: PrismaClient; jobs: JobPublisher }) {
  return {
    async evaluateProject(input: { workspaceId: string; projectId: string }): Promise<ProjectProgress | null> {
      const project = await deps.prisma.project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: { workItems: true, goal: true },
      });
      if (!project) return null;
      const required = project.workItems.filter((item) => item.required);
      const progress: ProjectProgress = {
        requiredTotal: required.length,
        completed: required.filter((item) => item.status === "completed").length,
        active: required.filter((item) => ["assigned", "planning", "in_progress"].includes(item.status)).length,
        blocked: required.filter((item) => item.status === "blocked").length,
        failed: required.filter((item) => item.status === "failed").length,
        reviewPending: required.filter((item) => ["waiting_review", "reviewing"].includes(item.status)).length,
        completionRatio: required.length === 0 ? 0 : required.filter((item) => item.status === "completed").length / required.length,
      };
      const target = project.status === "active" && required.length > 0 && progress.completed === required.length
        ? "completed"
        : project.status === "active" && (progress.blocked > 0 || progress.failed > 0)
          ? "blocked"
          : project.status === "blocked" && progress.blocked === 0 && progress.failed === 0
            ? "active"
            : null;
      if (target) {
        await deps.prisma.$transaction([
          deps.prisma.project.update({ where: { id: project.id }, data: { status: target } }),
          deps.prisma.companyEvent.create({
            data: {
              workspaceId: project.workspaceId,
              type: target === "completed" ? "project.completed" : target === "blocked" ? "project.blocked" : "project.progress_changed",
              projectId: project.id,
              goalId: project.goalId,
              payload: progress as never,
            },
          }),
        ]);
        if (project.goalId) await deps.jobs.enqueue(goalEvaluateJob(project.workspaceId, project.goalId));
      }
      return progress;
    },

    async evaluateGoal(input: { workspaceId: string; goalId: string }): Promise<GoalProgress | null> {
      const goal = await deps.prisma.companyGoal.findFirst({
        where: { id: input.goalId, workspaceId: input.workspaceId },
        include: { projects: true },
      });
      if (!goal) return null;
      const projects = goal.projects.filter((project) => project.status !== "cancelled");
      const progress: GoalProgress = {
        projectsTotal: projects.length,
        projectsCompleted: projects.filter((project) => project.status === "completed").length,
        projectsActive: projects.filter((project) => ["planned", "active", "paused"].includes(project.status)).length,
        projectsBlocked: projects.filter((project) => project.status === "blocked").length,
        completionRatio: projects.length === 0 ? 0 : projects.filter((project) => project.status === "completed").length / projects.length,
      };
      if (goal.status === "active" && projects.length > 0 && progress.projectsCompleted === projects.length) {
        await deps.prisma.$transaction([
          deps.prisma.companyGoal.update({ where: { id: goal.id }, data: { status: "achieved" } }),
          deps.prisma.companyEvent.create({ data: { workspaceId: goal.workspaceId, type: "goal.achieved", goalId: goal.id, payload: progress as never } }),
        ]);
      }
      return progress;
    },

    projectEvaluationJob(workspaceId: string, projectId: string) { return projectEvaluateJob(workspaceId, projectId); },
  };
}
