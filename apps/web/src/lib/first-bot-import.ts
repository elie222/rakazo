import type { Bot } from "@rakazo/contracts";
import { agentImportErrorReason } from "@rakazo/contracts";

type FirstBot = { id: string };
type ImportCreateRequest = { spawnKey?: string } & Record<string, unknown>;

/**
 * Imports an agent as the space's first bot, under the same cross-tab lock and spawn key
 * onboarding uses for Chief: if another tab already made the first bot, that bot is used
 * and nothing is imported, so a space never gets both.
 */
export async function importAsFirstBot<Request extends ImportCreateRequest>(
  deps: {
    lock: <T>(run: () => Promise<T>) => Promise<T>;
    existing: () => Promise<FirstBot | undefined>;
    spawnKey: string;
    importCreate: (input: Request) => Promise<Bot>;
  },
  input: Request,
): Promise<{ bot: FirstBot; imported: boolean }> {
  return deps.lock(async () => {
    const first = await deps.existing();
    if (first) return { bot: first, imported: false };
    try {
      const bot = await deps.importCreate({ ...input, spawnKey: deps.spawnKey });
      return { bot: { id: bot.id }, imported: true };
    } catch (error) {
      // Another device made the first bot meanwhile: the server keeps it and imports nothing.
      const made =
        agentImportErrorReason(error) === "first_bot_exists" ? await deps.existing() : undefined;
      if (!made) throw error;
      return { bot: made, imported: false };
    }
  });
}
