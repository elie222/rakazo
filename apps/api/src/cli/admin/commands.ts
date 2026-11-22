import { parseArgs } from "node:util";
import { accountDeleteCommand } from "./account-delete.js";
import type { AdminCommand, AdminContext, AdminResult } from "./admin-command.js";
import { billingCancelCommand, billingRefundCommand } from "./billing-commands.js";
import { botWebhookKeyCommand } from "./bot-webhook-key.js";
import { webhooksCheckCommand, webhooksUnpublishCommand } from "./webhooks-commands.js";

export const ADMIN_COMMANDS: readonly AdminCommand[] = [
  accountDeleteCommand,
  billingCancelCommand,
  billingRefundCommand,
  botWebhookKeyCommand,
  webhooksCheckCommand,
  webhooksUnpublishCommand,
];

export const ADMIN_USAGE = `Usage: admin.js <command> [--json]\n${ADMIN_COMMANDS.map(
  (command) => `  ${[...command.path, command.usage].filter(Boolean).join(" ")}`,
).join("\n")}\n`;

export type AdminInvocation = {
  json: boolean;
  run: (context: AdminContext) => Promise<AdminResult>;
};

/** The command and run these arguments ask for, or null when they match none. */
export function parseAdminArgs(argv: readonly string[]): AdminInvocation | null {
  const words = argv.filter((arg) => !arg.startsWith("-"));
  const command = ADMIN_COMMANDS.find((candidate) =>
    candidate.path.every((word, index) => words[index] === word),
  );
  if (!command) return null;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        ["json", ...command.flags].map((flag) => [flag, { type: "boolean" as const }]),
      ),
    });
  } catch {
    return null;
  }
  const flags = Object.fromEntries(
    Object.entries(parsed.values).map(([name, value]) => [name, value === true]),
  );
  const run = command.parse(parsed.positionals.slice(command.path.length), flags);
  return run ? { json: flags.json === true, run } : null;
}

export function formatAdminResult(result: AdminResult, json: boolean): string {
  return json ? `${JSON.stringify(result.json)}\n` : `${result.text}\n`;
}
