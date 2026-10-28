import type { Bot } from "@rakazo/contracts";
import { agentImportErrorReason } from "@rakazo/contracts";

type FirstBot = { id: string };
type ImportCreateRequest = { spawnKey?: string } & Record<string, unknown>;

/** Shares Chief's cross-tab lock and spawn key, so a space never gets both first bots. */
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
      // Another device made the first bot meanwhile.
      const made =
        agentImportErrorReason(error) === "first_bot_exists" ? await deps.existing() : undefined;
      if (!made) throw error;
      return { bot: made, imported: false };
    }
  });
}
