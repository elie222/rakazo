import os from "node:os";
import path from "node:path";
import { pageAppArgument } from "./page-app-launch.js";

/** The desktop file's name; Electron gives the app's windows the same name as their class. */
export function desktopFileName(appId: string): string {
  return `rakazo-page-app-${appId}.desktop`;
}

export function applicationsDir(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  // The base directory spec says a relative path is invalid and to be ignored.
  const data = env.XDG_DATA_HOME;
  return path.join(
    data && path.isAbsolute(data) ? data : path.join(home, ".local", "share"),
    "applications",
  );
}

/** A value of the Desktop Entry spec's string type. */
function text(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/^ /, "\\s");
}

/** One Exec argument, quoted, with what the spec reserves inside quotes and field codes escaped. */
function execArgument(value: string): string {
  return `"${value.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%")}"`;
}

export function desktopEntry(input: {
  appId: string;
  name: string;
  executable: string;
  icon: string;
}): string {
  const exec = [input.executable, pageAppArgument(input.appId)].map(execArgument).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.5",
    `Name=${text(input.name)}`,
    `Exec=${text(exec)}`,
    `Icon=${text(input.icon)}`,
    `StartupWMClass=${desktopFileName(input.appId).replace(/\.desktop$/, "")}`,
    "Categories=Utility;",
    "Terminal=false",
    "",
  ].join("\n");
}
