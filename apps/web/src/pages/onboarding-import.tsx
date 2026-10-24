import type { Bot } from "@rakazo/contracts";
import { importAsFirstBot } from "../lib/first-bot-import";
import { rpc } from "../lib/rpc";
import { AgentImportForm } from "./shell/agent-import";

type FirstBot = { id: string };

/** The import form, full width inside onboarding. */
export function OnboardingImport({
  firstBot,
  onBack,
  onDone,
}: {
  firstBot: {
    lock: <T>(run: () => Promise<T>) => Promise<T>;
    existing: () => Promise<FirstBot | undefined>;
    spawnKey: string;
  };
  onBack: () => void;
  onDone: (bot: FirstBot) => void;
}) {
  return (
    <AgentImportForm
      layout="page"
      onBack={onBack}
      onCancel={onBack}
      onCreated={(bot) => onDone(bot)}
      createBot={async (input) => {
        const result = await importAsFirstBot(
          { ...firstBot, importCreate: (request) => rpc.bots.importCreate(request) },
          input,
        );
        return { id: result.bot.id } as Bot;
      }}
    />
  );
}
