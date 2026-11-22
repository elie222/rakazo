import type { SecretStore } from "@rakazo/adapter-kit";
import type { Pool, PrismaClient } from "@rakazo/db";
import type { AppEnv } from "../../env.js";

export type AdminContext = AdminDbContext & {
  env: AppEnv;
  pool: Pool;
};

export type AdminDbContext = {
  prisma: PrismaClient;
  secrets: SecretStore;
  apiUrl: string;
  /** The public origin webhooks reach, when an ingress provider publishes one. */
  inboundOrigin?: string;
  signal: AbortSignal;
};

/** What a command reports: `text` for a person at the terminal, `json` for a program. */
export type AdminResult = { text: string; json: Record<string, unknown> };

export type AdminCommand = {
  /** The words that name it, such as `["bot", "webhook-key"]`. */
  path: readonly string[];
  /** Arguments and flags after the path, for the usage text. */
  usage: string;
  /** Flags it takes besides `--json`. */
  flags: readonly string[];
  /** The run for these arguments, or null when they do not fit. */
  parse(
    args: readonly string[],
    flags: Readonly<Record<string, boolean>>,
  ): ((context: AdminContext) => Promise<AdminResult>) | null;
};

/** A refusal the operator can act on: printed without a stack, exit status 1. */
export class AdminCommandError extends Error {}
