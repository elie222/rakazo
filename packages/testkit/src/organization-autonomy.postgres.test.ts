import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { createHumanAttentionService } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeterministicOrganizationJobQueue } from "../../adapters/src/test-support/organization-job-drain.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = enabled ? describe : describe.skip;

class OrganizationFixtureRuntime implements AgentRuntime {
  secondDeveloperPrompt = "";
  managerDecision?: { projectId: string; developerId: string; qaId: string };
  describe() { return { id: "organization-fixture", contractVersion: "1", adapterVersion: "test", capabilities: { streaming: true, compaction: false, tools: false, scripted: true } }; }
  async abort() {}
  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const prompt = request.prompt;
    let text: string;
    if (prompt.includes("<manager_identity_and_authority>")) {
      const decision = this.managerDecision;
      if (!decision) throw new Error("Manager fixture was not configured");
      text = JSON.stringify({ summary: "Create implementation work.", actions: [{ type: "create_work_item", projectId: decision.projectId, title: "Implement landing page", description: "Build the landing page.", expectedOutcome: "A working landing page ready for QA review.", assignedToBotId: decision.developerId, reviewerBotId: decision.qaId, priority: "high" }] });
    } else if (prompt.includes("You are the assigned reviewer")) {
      const second = prompt.includes("corrected-result");
      text = JSON.stringify(second ? { decision: "approve", summary: "Requirements satisfied.", feedback: null, evidence: [] } : { decision: "changes_requested", summary: "Responsive layout needs correction.", feedback: "Fix mobile responsiveness and hero alignment.", evidence: [] });
    } else {
      if (prompt.includes("prior_review_feedback")) this.secondDeveloperPrompt = prompt;
      text = prompt.includes("prior_review_feedback") ? "corrected-result" : "initial-result";
    }
    yield { type: "text", text };
    yield { type: "done", text };
  }
}

describeIntegration("autonomous organization flagship", () => {
  const queue = new DeterministicOrganizationJobQueue();
  const runtime = new OrganizationFixtureRuntime();
  let handles: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>;
  let ids: Record<string, string>;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({ databaseUrl: process.env.DATABASE_URL!, dataDir: `/tmp/rakazo-org-${Date.now()}`, sandboxProvider: "fake", agentRuntime: "scripted", defaultProvider: "scripted", defaultModel: "scripted", runtime, jobs: queue });
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const user = await handles.prisma.user.create({ data: { id: `org-user-${suffix}`, name: "Owner", email: `org-${suffix}@example.test` } });
    const workspace = await handles.prisma.organization.create({ data: { id: `org-${suffix}`, name: "Autonomy", slug: `autonomy-${suffix}`, createdAt: new Date() } });
    await handles.prisma.member.create({ data: { id: `member-${suffix}`, organizationId: workspace.id, userId: user.id, role: "owner" } });
    const computer = await handles.prisma.computer.create({ data: { workspaceId: workspace.id, userId: user.id, scope: "team", scopeKey: `team-${suffix}`, homeKey: `home-${suffix}`, kind: "fake", state: "running" } });
    const makeBot = async (name: string) => {
      const bot = await handles.prisma.bot.create({ data: { workspaceId: workspace.id, userId: user.id, name, color: "#000000", computerId: computer.id } });
      await handles.prisma.thread.create({ data: { workspaceId: workspace.id, botId: bot.id, userId: user.id, title: name } });
      return bot;
    };
    const manager = await makeBot("manager"); const developer = await makeBot("developer"); const qa = await makeBot("qa");
    const department = await handles.prisma.department.create({ data: { workspaceId: workspace.id, name: "Engineering", managerBotId: manager.id } });
    await handles.prisma.employeeProfile.create({ data: { workspaceId: workspace.id, botId: manager.id, departmentId: department.id, role: "manager", authority: { canCreateWorkItems: true, canAssignWork: true }, mission: "Plan", responsibilities: [] } });
    await handles.prisma.employeeProfile.create({ data: { workspaceId: workspace.id, botId: developer.id, departmentId: department.id, reportsToBotId: manager.id, role: "developer", authority: {}, mission: "Build", responsibilities: [] } });
    await handles.prisma.employeeProfile.create({ data: { workspaceId: workspace.id, botId: qa.id, departmentId: department.id, reportsToBotId: manager.id, role: "qa", authority: { canReview: true }, mission: "Review", responsibilities: [] } });
    const goal = await handles.prisma.companyGoal.create({ data: { workspaceId: workspace.id, title: "Build a simple landing page", status: "active" } });
    const project = await handles.prisma.project.create({ data: { workspaceId: workspace.id, goalId: goal.id, ownerBotId: manager.id, name: "Landing Page V1", status: "active" } });
    ids = { workspace: workspace.id, manager: manager.id, developer: developer.id, qa: qa.id, project: project.id, goal: goal.id };
    runtime.managerDecision = { projectId: project.id, developerId: developer.id, qaId: qa.id };
  });
  afterAll(async () => { await handles?.stop(); });

  it("runs manager → developer → QA revision loop from one manager job", async () => {
    await queue.enqueue({ name: "manager.evaluate", payload: { workspaceId: ids.workspace, managerBotId: ids.manager } });
    const result = await queue.drain(handles.jobHandlers, { maxJobs: 40 });
    const work = await handles.prisma.workItem.findFirstOrThrow({ where: { workspaceId: ids.workspace, projectId: ids.project }, include: { executions: { orderBy: { attempt: "asc" } }, reviews: { orderBy: { createdAt: "asc" } } } });
    const [project, goal, evaluation] = await Promise.all([handles.prisma.project.findUniqueOrThrow({ where: { id: ids.project } }), handles.prisma.companyGoal.findUniqueOrThrow({ where: { id: ids.goal } }), handles.prisma.managerEvaluation.findFirstOrThrow({ where: { projectId: ids.project } })]);
    expect(result.pending, result.trace).toBe(0);
    expect(result.trace.map((entry) => entry.name)).toEqual(expect.arrayContaining(["manager.evaluate", "workitem.dispatch", "workitem.review", "project.evaluate", "goal.evaluate"]));
    expect(evaluation).toMatchObject({ managerBotId: ids.manager, projectId: ids.project, attempt: 1, status: "completed" });
    expect(work).toMatchObject({ assignedToBotId: ids.developer, reviewerBotId: ids.qa, required: true, status: "completed" });
    expect(work.executions).toHaveLength(2); expect(new Set(work.executions.map((item) => item.runId)).size).toBe(2);
    expect(work.reviews).toHaveLength(2); expect(work.reviews.map((item) => item.status)).toEqual(["changes_requested", "approved"]);
    expect(work.reviews[0]?.feedback).toContain("mobile responsiveness");
    expect(runtime.secondDeveloperPrompt).toContain("Fix mobile responsiveness and hero alignment.");
    expect(project.status).toBe("completed"); expect(goal.status).toBe("achieved");
    expect(await handles.prisma.escalation.count({ where: { workspaceId: ids.workspace, status: "open" } })).toBe(0);
    expect(await createHumanAttentionService(handles.prisma).getHumanAttentionItems(ids.workspace)).toEqual([]);
  });
});
