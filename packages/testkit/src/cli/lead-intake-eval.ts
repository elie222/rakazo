import path from "node:path";
import {
  EXPECTED_RUN_COUNT,
  ITERATIONS,
  planCampaign,
  runCampaign,
  type SandboxMode,
} from "../evaluations/lead-intake-v1/run.js";

/**
 * `pnpm test:eval:lead-intake-v1 -- --runtime=scripted --sandbox=fake --iterations=3 --output=<dir> [--campaign=<id>] [--dry-run] [--resume] [--candidate-revision=<sha>]`
 *
 * Deliberately explicit and separate from `pnpm test`: this produces a real 60-run
 * evidence campaign on disk, not a fast in-memory unit test. See Plan 03 item 5.
 */

interface CliArgs {
  runtime: "scripted";
  sandbox: SandboxMode;
  iterations: number;
  output: string;
  campaign: string;
  dryRun: boolean;
  resume: boolean;
  candidateRevision?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) bools.add(body);
    else flags.set(body.slice(0, eq), body.slice(eq + 1));
  }

  const runtime = flags.get("runtime") ?? "scripted";
  if (runtime !== "scripted") {
    throw new Error(
      `runtime=${runtime} is not permitted in this phase; only "scripted" is authorized (SOLO-OPERATOR-APPROVAL-20260829.md)`,
    );
  }
  const sandbox = flags.get("sandbox") ?? "fake";
  if (sandbox !== "fake") {
    throw new Error(`sandbox=${sandbox} is not permitted in this phase; only "fake" is authorized`);
  }

  return {
    runtime: "scripted",
    sandbox: "fake",
    iterations: Number(flags.get("iterations") ?? ITERATIONS),
    output: flags.get("output") ?? "test-report/lead-intake-quote-readiness-v1/campaign",
    campaign: flags.get("campaign") ?? `lead-intake-v1-${Date.now()}`,
    dryRun: bools.has("dry-run"),
    resume: bools.has("resume"),
    candidateRevision: flags.get("candidate-revision"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.output);

  if (args.dryRun) {
    const plan = planCampaign(args.iterations);
    console.log(JSON.stringify({ dry_run: true, planned_runs: plan.length, plan }, null, 2));
    if (plan.length !== EXPECTED_RUN_COUNT && args.iterations === ITERATIONS) {
      throw new Error(`expected ${EXPECTED_RUN_COUNT} planned runs, computed ${plan.length}`);
    }
    return;
  }

  const result = await runCampaign({
    campaignId: args.campaign,
    runtime: args.runtime,
    sandbox: args.sandbox,
    iterations: args.iterations,
    outputDir,
    candidateRevision: args.candidateRevision,
    resume: args.resume,
  });

  console.log(
    JSON.stringify(
      {
        campaign_id: result.campaignId,
        planned_runs: result.plannedRuns,
        completed_runs: result.completedRuns,
        manifest_path: result.manifestPath,
        shutdown: result.shutdown,
      },
      null,
      2,
    ),
  );

  if (result.shutdown.triggered && result.completedRuns < result.plannedRuns) {
    console.error(`campaign halted before completion: ${result.shutdown.reason}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
