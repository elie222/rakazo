import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpAgentDescriptor } from "../../../runtime/acp/acp-agent.js";
import { OPENCODE_CLI_PROVIDER_ID } from "./provider-id.js";

/** OpenCode's own agent that runs the bot, set up by the config below. */
const AGENT = "rakazo";

/**
 * Every tool OpenCode has is denied, which also removes it from the model's tool list, and only
 * the tool server's tools are allowed. Set on the agent itself as well, because an agent's rules
 * are applied after the global ones.
 */
function permissions(toolServer: string) {
  return { "*": "deny", [`${toolServer}_*`]: "allow" };
}

/**
 * The whole OpenCode config for one turn. Rakazo's instructions replace OpenCode's own system
 * prompt, and nothing is shared or saved for undo. The legacy keys are read by every OpenCode
 * release that has ACP.
 */
export function openCodeConfig(instructions: string, toolServer: string) {
  return {
    permission: permissions(toolServer),
    agent: {
      [AGENT]: {
        mode: "primary",
        prompt: instructions,
        permission: permissions(toolServer),
      },
    },
    default_agent: AGENT,
    // OpenCode 2 lists its skill tool whatever the permissions say (it refuses the call itself),
    // so its built-in plugin is removed outright. Earlier releases ignore the key.
    plugins: ["-opencode.tool.skill"],
    share: "disabled",
    autoupdate: false,
    snapshot: false,
  };
}

/**
 * OpenCode runs `opencode acp`, as installed. Rakazo never signs it in or reads its sign-in: the
 * operator signs in once with `opencode auth login` (its free models need none), and OpenCode
 * keeps that in its own data folder, which stays where it is.
 */
export const openCodeAgent: AcpAgentDescriptor = {
  id: OPENCODE_CLI_PROVIDER_ID,
  label: "OpenCode",
  command: "opencode",
  notInstalled:
    "OpenCode is not installed on this server. Install it for the user that runs the Rakazo worker.",
  async launch({ files, instructions, toolServer, env }) {
    const config = join(files, "opencode.json");
    await writeFile(config, JSON.stringify(openCodeConfig(instructions, toolServer)), {
      mode: 0o600,
    });
    // An empty config folder in place of the operator's own, so their plugins, MCP servers,
    // agents and instruction files stay out of the bot's turn.
    const configDir = join(files, "config");
    await mkdir(configDir, { mode: 0o700 });
    // Its global config is found under the config home too, so that is an empty one as well.
    const configHome = join(files, "config-home");
    await mkdir(configHome, { mode: 0o700 });
    return {
      args: ["acp"],
      env: {
        ...env,
        OPENCODE_CONFIG: config,
        OPENCODE_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    };
  },
  toolCallName: (toolServer, tool) => `${toolServer}_${tool}`,
  // Before 2.0, OpenCode names the tool only in the first update's title.
  reportedToolName: (update) =>
    typeof update.name === "string"
      ? update.name
      : update.sessionUpdate === "tool_call" && typeof update.title === "string"
        ? update.title
        : undefined,
};
