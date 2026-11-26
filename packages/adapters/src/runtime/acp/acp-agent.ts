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
  /** Shown when the command is not on PATH. */
  notInstalled: string;
  /**
   * Whether the CLI passes images to its model, in the message and in tool results. It decides
   * whether the bot can see screenshots and the images people send.
   */
  acceptsImages?: boolean;
  /** How the operator signs the CLI in, shown when it says it is not signed in. */
  signIn?: string;
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
  /**
   * The `_meta` every session request carries, for a CLI that takes its settings (its own tools
   * off, Rakazo's instructions as its system prompt) per session instead of at launch.
   */
  sessionMeta?(input: { instructions: string; toolServer?: string }): Record<string, unknown>;
  /** The name the CLI reports a call to one of the tool server's tools under. */
  toolCallName(toolServer: string, tool: string): string;
  /**
   * The tool name a `tool_call` or `tool_call_update` reports, where the CLI puts it somewhere
   * other than the protocol's `name` field. Undefined when the update names no tool.
   */
  reportedToolName?(update: Record<string, unknown>): string | undefined;
  /**
   * Whether an error answering a resume means the CLI has no such session, where it says so in a
   * way other than the protocol's invalid-params answer.
   */
  isMissingSession?(error: { code: number; message: string; data?: unknown }): boolean;
}
