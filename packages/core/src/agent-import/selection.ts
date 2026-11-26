import type {
  AgentImportCreateInput,
  AgentImportMemoryDestination,
  AgentImportPlan,
} from "@rakazo/contracts";
import { looksLikeCredential } from "./credentials.js";

/**
 * Everything starts ticked but the untouched defaults the source wrote. Routines arrive
 * paused, and the bot asks before it uses an MCP server.
 */
export function agentImportUncheckedByDefault(plan: AgentImportPlan): string[] {
  return [
    // A skill joins the library every bot shares, and an export is text someone else or a
    // model wrote: one that carries code or files comes over only when it is ticked.
    ...plan.skills.filter((item) =>
      item.warnings.some((warning) => warning === "runs_code" || warning === "bundled_files"),
    ),
    ...plan.instructions.filter((item) => item.stock),
    ...plan.memory.filter((item) => item.stock),
    // Key-looking text reaches a bot only when the user ticks it.
    ...[...plan.instructions, ...plan.memory, ...plan.skills].filter((item) => item.containsKey),
    ...plan.routines.filter((item) => looksLikeCredential(item.content)),
  ].map((item) => item.id);
}

/** What a create sends for a reviewed plan; items that cannot work here are never sent. */
export function agentImportSelection(
  plan: AgentImportPlan,
  choices: {
    unchecked: ReadonlySet<string>;
    destinations: Readonly<Record<string, AgentImportMemoryDestination>>;
    modelUsable: boolean;
  },
): AgentImportCreateInput["selection"] {
  const { unchecked, destinations } = choices;
  const chosen = <T extends { id: string }>(items: T[]) =>
    items.filter((item) => !unchecked.has(item.id));
  const works = (item: { status: { kind: string }; warnings: readonly string[] }) =>
    item.status.kind !== "unsupported" && !item.warnings.includes("unsupported_command");
  return {
    instructions: chosen(plan.instructions).map((item) => item.id),
    memory: chosen(plan.memory).map((item) => ({
      id: item.id,
      destination: destinations[item.id] ?? "bot",
    })),
    skills: chosen(plan.skills)
      .filter(works)
      .map((item) => item.id),
    model: Boolean(plan.model && choices.modelUsable && !unchecked.has(plan.model.id)),
    mcpServers: chosen(plan.mcpServers)
      .filter(works)
      .map((item) => item.id),
    routines: chosen(plan.routines).map((item) => item.id),
    apiKeys: chosen(plan.apiKeys).map((item) => item.id),
    // Not asked about: what the import cannot set up always goes to the new bot's chat.
    leftovers: chosen(plan.leftovers).map((item) => item.id),
  };
}
