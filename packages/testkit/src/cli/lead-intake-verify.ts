import path from "node:path";
import { EXIT_CODES, verifyCampaign } from "../evaluations/lead-intake-v1/verify.js";

/**
 * `pnpm verify:eval:lead-intake-v1 -- --campaign=<dir>`
 *
 * Independent of `lead-intake-eval.ts` by design: this process only reads
 * evidence and frozen expected outcomes from disk. It never imports the runner,
 * the model runtime, connectors, or the sandbox. Exit code is the contract:
 * 0 = ACCEPT, 1 = REJECT, 2 = INVALID_PACK.
 */

function parseArgs(argv: string[]): { campaignDir: string } {
  const flags = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) flags.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  const campaign = flags.get("campaign");
  if (!campaign) throw new Error("--campaign=<dir> is required");
  return { campaignDir: path.resolve(campaign) };
}

function main() {
  const { campaignDir } = parseArgs(process.argv.slice(2));
  const report = verifyCampaign({ campaignDir });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = EXIT_CODES[report.verdict];
}

main();
