/**
 * An agent CLI that runs a bot over the Agent Client Protocol. Each provider describes its own CLI
 * here; the ACP runtime is the same for all of them.
 */
export interface AcpAgentDescriptor {
  /** The deployment provider id that selects this CLI. */
  id: string;
  /** What people call the CLI, in errors. */
  label: string;
  /** The executable on the server's PATH. */
  command: string;
  /** Environment names, beyond the shared allowlist, where the CLI keeps its own sign-in. */
  ownEnv?: readonly string[];
  /** Shown when the command is not on PATH. */
  notInstalled: string;
  /**
   * How one turn starts the CLI: with every one of its own tools, settings, instruction files and
   * plugins off, the tool server's tools allowed, and Rakazo's instructions as its system prompt.
   * `files` is a private folder for this turn only.
   */
  launch(input: {
    files: string;
    instructions: string;
    toolServer: string;
    env: Record<string, string>;
  }): Promise<{ args: string[]; env: Record<string, string> }>;
  /** The name the CLI reports a call to one of the tool server's tools under. */
  toolCallName(toolServer: string, tool: string): string;
  /**
   * The tool name a `tool_call` or `tool_call_update` reports, where the CLI puts it somewhere
   * other than the protocol's `name` field. Undefined when the update names no tool.
   */
  reportedToolName?(update: Record<string, unknown>): string | undefined;
}
