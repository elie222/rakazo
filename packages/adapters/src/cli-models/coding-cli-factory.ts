import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import type {
  ComputerCodingCliCall,
  ComputerCodingCliResult,
} from "../providers/cli-model/cursor/cli.js";
import { executeComputerCodingCli } from "../providers/cli-model/cursor/cli.js";
import { assertCursorComputerCliBin } from "../providers/cli-model/cursor/descriptor.js";
import { CURSOR_COMPUTER_CLI_ID } from "../providers/cli-model/cursor/provider-id.js";
import { resolveCodingCliProvider } from "./coding-cli-provider-env.js";

export type CodingCliExecute = (
  execute: (request: CommandRequest) => AsyncIterable<ProcessEvent>,
  call: ComputerCodingCliCall,
) => Promise<ComputerCodingCliResult>;

export interface CodingCliConnection {
  /** Opaque provider id from the cli-model family. */
  providerId: string;
  apiKey: string;
  command: string;
  execute: CodingCliExecute;
  /** The one Space allowed to spend this deployment's key (CLOUD_AGENT_SPACE_ID). */
  spaceId: string;
}

/**
 * The composition root binds a credential to one computer coding CLI implementation and to the
 * one Space that may use it. Without CLOUD_AGENT_SPACE_ID the feature stays off.
 */
export function createCodingCliConnection(
  source: NodeJS.ProcessEnv = process.env,
): CodingCliConnection | null {
  const kind = resolveCodingCliProvider(source);
  if (kind !== CURSOR_COMPUTER_CLI_ID) return null;
  const spaceId = source.CLOUD_AGENT_SPACE_ID?.trim();
  if (!spaceId) return null;
  const enabled = true;
  return {
    providerId: CURSOR_COMPUTER_CLI_ID,
    apiKey: source.CURSOR_API_KEY!.trim(),
    command: assertCursorComputerCliBin(source, enabled),
    execute: executeComputerCodingCli,
    spaceId,
  };
}
