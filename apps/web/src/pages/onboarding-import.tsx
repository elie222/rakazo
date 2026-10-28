import type { Bot } from "@rakazo/contracts";
import { useRef } from "react";
import { importAsFirstBot } from "../lib/first-bot-import";
import { rpc } from "../lib/rpc";
import { AgentImportForm } from "./shell/agent-import";

type FirstBot = { id: string };

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
  /** `imported` is false when another first bot already existed and nothing was imported. */
  onDone: (bot: FirstBot, imported: boolean) => void;
}) {
  const imported = useRef(false);
  return (
    <AgentImportForm
      layout="page"
      onBack={onBack}
      onCancel={onBack}
      onCreated={(bot) => onDone(bot, imported.current)}
      createBot={async (input) => {
        const result = await importAsFirstBot(
          { ...firstBot, importCreate: (request) => rpc.bots.importCreate(request) },
          input,
        );
        imported.current = result.imported;
        return { id: result.bot.id } as Bot;
      }}
    />
  );
}
