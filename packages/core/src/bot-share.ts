import {
  type Bot,
  SHARE_MANIFEST_VERSION,
  type ShareManifest,
  type ShareRoutineTemplate,
} from "@rakazo/contracts";

export function buildShareManifest(
  bot: Pick<
    Bot,
    "name" | "title" | "description" | "instructions" | "color" | "notifyOnFinish" | "computerMode"
  >,
  routines: ShareRoutineTemplate[] = [],
): ShareManifest {
  return {
    version: SHARE_MANIFEST_VERSION,
    sharedAt: new Date().toISOString(),
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    computerMode: bot.computerMode,
    routines,
  };
}
