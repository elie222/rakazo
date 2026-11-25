import { randomUUID } from "node:crypto";
import { link, mkdir, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateFolder } from "../../../cli-models/cli-process.js";
import type { AcpAgentDescriptor } from "../../../runtime/acp/acp-agent.js";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "./provider-id.js";

/** The CLI's own folder inside its home, which holds its sessions and, off macOS, its sign-in. */
const ACP_FOLDER = "antigravity-acp";

/**
 * What the CLI's own folder needs from the operator's to stay signed in: the sign-in it saved
 * (macOS keeps it in the keychain instead) and the settings that say which sign-in it uses. Only
 * linked, never read.
 */
const SIGN_IN_FILES = ["acp_token.json", "acp_business_token.json", "settings.json"];

/**
 * The CLI's home for bots: a private folder of Rakazo's in place of `~/.gemini`, so the operator's
 * hooks, MCP servers, skills and shared settings stay out of the bot's turn. It lasts across turns
 * because the CLI keeps its sessions there.
 */
const botHome = privateFolder("rakazo-antigravity-home", false);

async function linkSignIn(home: string, operatorHome: string): Promise<void> {
  const own = join(home, ACP_FOLDER);
  await mkdir(own, { recursive: true, mode: 0o700 });
  for (const name of SIGN_IN_FILES) {
    // Made anew every turn, replacing a file the CLI wrote in its place (a refreshed sign-in), so
    // signing out or switching accounts in the operator's own folder always reaches the bots. A
    // link made beside it and renamed over it leaves no moment without one.
    const next = join(own, `.${name}.${randomUUID()}`);
    const target = join(operatorHome, ACP_FOLDER, name);
    try {
      await symlink(target, next);
    } catch (error) {
      // Windows lets only some accounts make symlinks; a hard link needs no privilege.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
      try {
        await link(target, next);
      } catch (linkError) {
        // A hard link needs its file; a sign-in file the operator does not have is skipped.
        if ((linkError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw linkError;
      }
    }
    await rename(next, join(own, name));
  }
}

/**
 * The CLI runs `agy acp`, as installed. Rakazo never signs it in or reads its sign-in: the operator
 * signs in once with `agy acp --login`. Every session turns off all of the CLI's built-in tools,
 * loads Rakazo's tool server up front so its calls carry the server's name, and adds Rakazo's
 * instructions to the CLI's system prompt, which is as far as the CLI lets a client change it.
 */
export const antigravityAgent: AcpAgentDescriptor = {
  id: ANTIGRAVITY_CLI_PROVIDER_ID,
  label: "Antigravity",
  command: "agy",
  acceptsImages: true,
  notInstalled:
    "The Antigravity CLI is not installed on this server. Install it for the user that runs the Rakazo worker.",
  signIn: "Run `agy acp --login` in a terminal as the user that runs the Rakazo worker.",
  async launch({ env }) {
    const home = botHome();
    await linkSignIn(home, join(homedir(), ".gemini"));
    return { args: ["acp"], env: { ...env, GEMINI_HOME: home } };
  },
  sessionMeta: ({ instructions, toolServer }) => ({
    antigravity: {
      enabledTools: [],
      eagerMcpServers: toolServer ? [toolServer] : [],
      systemPrompt: { append: instructions },
    },
  }),
  toolCallName: (toolServer, tool) => `${toolServer}_${tool}`,
  // The CLI names a call in its first update's title, prefixed with its MCP server's name.
  reportedToolName: (update) =>
    typeof update.name === "string"
      ? update.name
      : update.sessionUpdate === "tool_call" && typeof update.title === "string"
        ? update.title
        : undefined,
};
