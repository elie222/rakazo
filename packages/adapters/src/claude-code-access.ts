import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { ClaudeCodeAccessCheck } from "./claude-code-provider.js";
import { modelCreditBillingEnabled } from "./run-model.js";

export const CLAUDE_CODE_BILLING_REFUSAL =
  "Claude Code is turned off on servers that bill for model usage.";
export const CLAUDE_CODE_SHARED_REFUSAL =
  "Claude Code runs only on a server with one account, because its sign-in belongs to one person.";

const ALLOWED_CACHE_MS = 60_000;

/**
 * A CLI sign-in is one person's plan, so the server must not sell model usage or serve anyone
 * else with it; the hosted service does both. People who only message bots from chat apps have
 * no account to sign in.
 */
export function claudeCodeAccessCheck(deps: {
  prisma: PrismaClient;
  billingEnabled?: boolean;
}): ClaudeCodeAccessCheck {
  let allowedUntil = 0;
  return async () => {
    if (Date.now() < allowedUntil) return undefined;
    if (await modelCreditBillingEnabled(deps)) return CLAUDE_CODE_BILLING_REFUSAL;
    const people = await runAsSystem("check that Claude Code serves one person", () =>
      deps.prisma.user.count({
        where: { deactivatedAt: null, NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } },
      }),
    );
    if (people > 1) return CLAUDE_CODE_SHARED_REFUSAL;
    allowedUntil = Date.now() + ALLOWED_CACHE_MS;
    return undefined;
  };
}
