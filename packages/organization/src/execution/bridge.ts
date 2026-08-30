/**
 * OrganizationExecutionBridge — thin bridge between WorkItem and Rakazo Task/Run.
 * Does not call vendor SDKs directly; reuses existing Task/Run → Executor path.
 */

import type { PrismaClient } from "@rakazo/db";

export type ExecuteWorkItemInput = {
  prisma: PrismaClient;
  workspaceId: string;
  workItemId: string;
  actorBotId: string;
  // Optional: context for building execution instruction
  instructionOverride?: string;
};

export async function buildWorkItemInstruction(input: {
  title: string;
  description: string;
  expectedOutcome: string;
  projectName?: string | null;
  goalTitle?: string | null;
}): Promise<string> {
  const parts: string[] = [];
  parts.push(`Work: ${input.title}`);
  if (input.description) parts.push(`\nDescription: ${input.description}`);
  if (input.projectName) parts.push(`Project: ${input.projectName}`);
  if (input.goalTitle) parts.push(`Goal: ${input.goalTitle}`);
  if (input.expectedOutcome) parts.push(`Expected outcome: ${input.expectedOutcome}`);
  parts.push(`\nComplete this work and report the result concisely.`);
  return parts.join("\n");
}

// NOTE: Actual Task/Run creation is performed in API layer via existing repos
// to keep this package free of adapter-kit wiring. This file defines the
// contract + helper. Worker will import and orchestrate.

export function workItemToTaskPrompt(workItem: {
  title: string;
  description: string;
  expectedOutcome: string;
}): string {
  return `${workItem.title}${workItem.description ? ` — ${workItem.description}` : ""}${workItem.expectedOutcome ? ` (Outcome: ${workItem.expectedOutcome})` : ""}`;
}
