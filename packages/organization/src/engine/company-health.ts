import type { PrismaClient } from "@rakazo/db";

export type CompanyHealthReport = {
  stalledProjects: string[];
  blockedProjects: string[];
  overloadedEmployees: string[];
  idleEmployees: string[];
  excessiveFailures: string[];
  reviewBottlenecks: string[];
  goalsWithoutProjects: string[];
  projectsWithoutWork: string[];
  unresolvedEscalations: string[];
  approvalBottlenecks: string[];
  evaluatedAt: string;
};

export async function evaluateCompanyHealth(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<CompanyHealthReport> {
  const [projects, workItems, goals, escalations, runtimeStates, reviews] = await Promise.all([
    prisma.project.findMany({ where: { workspaceId } }),
    prisma.workItem.findMany({ where: { workspaceId } }),
    prisma.companyGoal.findMany({ where: { workspaceId } }),
    prisma.escalation.findMany({ where: { workspaceId, status: { in: ["open", "acknowledged"] } } }),
    prisma.employeeRuntimeState.findMany({ where: { workspaceId } }),
    prisma.workItemReview.findMany({ where: { workspaceId, status: "pending" } }),
  ]);

  const workByProject = new Map<string, number>();
  for (const w of workItems as Array<{ projectId: string | null }>) if (w.projectId) workByProject.set(w.projectId, (workByProject.get(w.projectId) ?? 0) + 1);

  const goalIds = new Set((goals as Array<{ id: string }>).map((g) => g.id));
  const projectsByGoal = new Map<string, number>();
  for (const p of projects as Array<{ goalId: string | null }>) if (p.goalId) projectsByGoal.set(p.goalId, (projectsByGoal.get(p.goalId) ?? 0) + 1);

  const blockedProjects = (projects as Array<{ id: string; status: string }>).filter((p) => p.status === "blocked").map((p) => p.id);
  const stalledProjects = (projects as Array<{ id: string; status: string }>)
    .filter((p) => p.status === "active" && (workByProject.get(p.id) ?? 0) === 0)
    .map((p) => p.id);

  const failedCounts = new Map<string, number>();
  for (const w of workItems as Array<{ status: string; assignedToBotId: string | null }>) if (w.status === "failed" && w.assignedToBotId) failedCounts.set(w.assignedToBotId, (failedCounts.get(w.assignedToBotId) ?? 0) + 1);
  const excessiveFailures = [...failedCounts.entries()].filter(([, c]: [string, number]) => c >= 3).map(([botId]: [string, number]) => botId);

  const overdueReviews = (reviews as Array<{ id: string }>).length > 5 ? (reviews as Array<{ id: string }>).map((r) => r.id) : [];
  const approvalBottlenecks = (workItems as Array<{ id: string; status: string }>).filter((w) => w.status === "waiting_approval").map((w) => w.id);
  const goalsWithoutProjects: string[] = [...goalIds].filter((gid: string) => !projectsByGoal.has(gid));
  const projectsWithoutWork = (projects as Array<{ id: string }>).filter((p) => !workByProject.has(p.id)).map((p) => p.id);
  const idleEmployees = (runtimeStates as Array<{ status: string; botId: string }>).filter((r) => r.status === "idle").map((r) => r.botId);
  const overloaded = (runtimeStates as Array<{ status: string; botId: string }>).filter((r) => r.status === "working").map((r) => r.botId);
  const overloadedEmployees = overloaded.length > 3 ? overloaded : [];

  const report: CompanyHealthReport = {
    stalledProjects,
    blockedProjects,
    overloadedEmployees,
    idleEmployees,
    excessiveFailures,
    reviewBottlenecks: overdueReviews,
    goalsWithoutProjects,
    projectsWithoutWork,
    unresolvedEscalations: escalations.map((e) => e.id),
    approvalBottlenecks,
    evaluatedAt: new Date().toISOString(),
  };
  return report;
}
