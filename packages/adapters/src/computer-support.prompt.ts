import path from "node:path";
import { teamBotWorkspaceDirectory } from "./computer-support.js";

export function teamWorkspaceInstruction(botId: string): string {
  const home = teamBotWorkspaceDirectory(botId);
  const sharedFromShell = `${path.posix.relative(home, "shared")}/`;
  return `Your Team Computer home is ${home}. Relative file paths and shell working directories start there. Put intentionally shared work under shared/. File tools resolve shared/ and bots/ from the Team root, but shell commands do not: from your home, a shell command reaches shared work as ${sharedFromShell}, and a shell cwd of shared starts in it. Other bots' folders are visible under bots/; treat them as their working areas.`;
}
