import { encodeTarEntry } from "./exec-computer.js";
import { simpleCommand } from "./linux-desktop.test-support.js";

export type ExecOutput = { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };

/**
 * An in-memory shell for providers built on the shared exec computer: it understands only what
 * the adapter sends for files, export, the screen, and `env`, `echo` and `printenv` commands.
 */
export function execComputerShell() {
  const files = new Map<string, { content: Buffer; executable: boolean }>();
  let exportedNames: string[] = [];
  function run(command: string[], input: Buffer = Buffer.alloc(0)): ExecOutput {
    const write = command.indexOf("rakazo-write");
    if (write >= 0) {
      files.set(command[write + 1]!, { content: input, executable: command[write + 2] === "700" });
      return {};
    }
    if (command.includes("rakazo-export-list")) {
      exportedNames = input.toString().split("\0").filter(Boolean);
      return {};
    }
    const exec = command.indexOf("rakazo-exec");
    if (exec >= 0) {
      // `cd`, the request's environment, then `timeout` and its three options before the command.
      const timeout = command.indexOf("timeout");
      const { exitCode, stdout } = simpleCommand(
        ["env", ...command.slice(exec + 2, timeout), ...command.slice(timeout + 4)],
        {},
      );
      return { stdout, code: exitCode };
    }
    if (command.includes("stat"))
      return { stdout: String(files.get(command.at(-1)!)!.content.length) };
    if (command.includes("cat")) return { stdout: files.get(command.at(-1)!)!.content };
    if (command.includes("find") || command.some((arg) => arg.includes("find . -regextype"))) {
      const directory = command.includes("find")
        ? command[command.indexOf("find") + 1]!
        : "/home/rakazo";
      let stdout = "";
      for (const [name, file] of files) {
        if (!name.startsWith(`${directory}/`)) continue;
        const relative = name.slice(directory.length + 1);
        if (!command.includes("-maxdepth")) stdout += `${relative}\0`;
        else if (!relative.includes("/"))
          stdout += `${relative}\0f\0${file.content.length}\0${file.executable ? "700" : "600"}\0`;
      }
      return { stdout };
    }
    if (command.includes("tar")) {
      const chunks = exportedNames.flatMap((name) => {
        const file = files.get(`/home/rakazo/${name}`)!;
        return [...encodeTarEntry(name, file.content, file.executable)];
      });
      return { stdout: Buffer.concat([...chunks, Buffer.alloc(1024)]) };
    }
    if (command.some((arg) => arg.includes("RAKAZO_DESKTOP=")))
      return { stdout: "RAKAZO_DESKTOP=0:offline-view-token\n" };
    if (command.some((arg) => arg.includes("getmouselocation")))
      return { stdout: "cG5n\nCURSOR X=1 Y=2\n" };
    return {};
  }
  return { files, run };
}
