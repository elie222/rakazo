import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./evals/cases.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)("group eval tool budget", () => {
  it("stops a group trial while a member is still working past the tool budget", async () => {
    const fixtureKey = "offline-group-budget-key";
    // Two members wake for one unaddressed message. The subject answers after two tool
    // calls; Mika keeps calling tools, which the trial budget must stop mid-work.
    const subjectTools = 2;
    const memberTools = 8;
    const totalCalls = subjectTools + memberTools + 2; // Each member ends with one text turn.
    // Members decide at about the same time, so the fixture cannot pin run order: every
    // step serves either member, and Mika's first call waits for the subject's finished
    // run, so the trial's per-step watch has ended before Mika's work counts up.
    let subjectCalls = 0;
    let memberCalls = 0;
    const isMember = (request: ModelEmulatorRequest) =>
      JSON.stringify(request.messages).includes("member-keeps-searching");
    const { createDb, asSystem } = await import("@rakazo/db");
    const db = createDb(process.env.DATABASE_URL!);
    const system = asSystem(db.prisma);
    const subjectRunDone = async () => {
      const assistant = await system.bot.findFirst({
        where: { name: "Assistant" },
        select: { id: true },
      });
      return assistant
        ? Boolean(
            await system.run.findFirst({
              where: { botId: assistant.id, trigger: "user", status: "completed" },
              select: { id: true },
            }),
          )
        : false;
    };
    const steps: ModelEmulatorStep[] = Array.from({ length: totalCalls }, () => ({
      async expect(request) {
        if (!isMember(request)) return;
        if (memberCalls === 0) {
          const gateDeadline = Date.now() + 20_000;
          while (!(await subjectRunDone()) && Date.now() < gateDeadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Stretch each member call past the wait loop's poll interval, as real paid
        // calls are, so the breach is observable while Mika is still working.
        await new Promise((resolve) => setTimeout(resolve, 150));
      },
      response: (request: ModelEmulatorRequest) => {
        if (!isMember(request)) {
          subjectCalls += 1;
          if (subjectCalls <= subjectTools)
            return {
              type: "tool" as const,
              id: `subject-search-${subjectCalls}`,
              name: "search_history",
              arguments: { query: `release-${subjectCalls}` },
            };
          return { type: "text" as const, text: "Nothing blocking from my side." };
        }
        memberCalls += 1;
        if (memberCalls <= memberTools)
          return {
            type: "tool" as const,
            id: `member-search-${memberCalls}`,
            name: "search_history",
            arguments: { query: `release-${memberCalls}` },
          };
        return { type: "text" as const, text: "I checked every record; nothing blocks." };
      },
    }));
    const model = await startModelEmulator({ apiKey: fixtureKey, steps });
    const scenario: EvalCase = {
      id: "group-tool-budget",
      purpose:
        "The trial tool budget stops a member still working after the first member's run ended.",
      steps: [{ ask: "Quick check: does anything block tonight's release?", unaddressed: true }],
      group: {
        members: ["Mika"],
        roles: {
          Assistant: "Chief of staff: tracks the release and answers for it.",
          Mika: "Archives: searches the records for anything blocking.",
        },
        instructions: {
          Assistant: "You coordinate releases. Marker: subject-answers-at-once.",
          Mika: "You search the archive until certain. Marker: member-keeps-searching.",
        },
      },
      grade: () => [],
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-group-budget-"));
    // The per-run product cap would end Mika's turn at the trial budget, hiding the
    // window the trial itself must guard; keep the run cap above it for this fixture.
    const previousRunCap = process.env.MAX_TOOL_CALLS_PER_TURN;
    process.env.MAX_TOOL_CALLS_PER_TURN = "0";
    try {
      const { createApp } = await import("@rakazo/api/app");
      const result = await runTrial(scenario, 1, {
        connection: {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        },
        timeoutMs: 30_000,
        // The trial budget (subject's two calls plus Mika's ongoing ones) trips at
        // Mika's fourth call, in the group wait after the subject's run already ended.
        maxToolCalls: 5,
        createApp: (composio, messaging) => {
          const sandbox = new EvalSandboxProvider();
          return createApp({
            sandbox,
            databaseUrl: process.env.DATABASE_URL!,
            realtimeDatabaseUrl: process.env.DATABASE_URL!,
            authUrl: "http://127.0.0.1:5173",
            webOrigin: "http://127.0.0.1:5173",
            dataDir,
            sandboxProvider: "fake",
            agentRuntime: "pi",
            wakeupDriver: "memory",
            signupsEnabled: "true",
            composio,
            messaging,
            messagingOpenSignup: false,
            cloudAgentProvider: "none",
            encryptionKey: "offline-group-eval-encryption-key",
          });
        },
      });
      expect(result.category).toBe("incomplete");
      expect(result.reason).toBe("Tool call budget exceeded");
      // The trial stopped before Mika's scripted work ran out, and cleanup stopped
      // the run instead of letting it finish through the drain.
      expect(memberCalls).toBeLessThan(memberTools + 1);
      expect(model.requests.length).toBeLessThan(totalCalls);
      const mikaBot = await system.bot.findFirst({ where: { name: "Mika" }, select: { id: true } });
      const mikaRun = mikaBot
        ? await system.run.findFirst({
            where: { botId: mikaBot.id, trigger: "user" },
            select: { status: true },
          })
        : null;
      expect(mikaRun?.status).toBe("cancelled");
    } finally {
      if (previousRunCap === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
      else process.env.MAX_TOOL_CALLS_PER_TURN = previousRunCap;
      await model.close();
      await db.prisma.$disconnect();
      await db.pool.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
