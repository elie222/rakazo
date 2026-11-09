import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { computerObservation, FakeSandboxProvider } from "@rakazo/adapters";
import { PNG } from "pngjs";

/** What a scripted check prints and how it exits; a failing check prints to stderr. */
export interface ScriptedCheck {
  match: RegExp;
  output: string;
  /** Defaults to 0. */
  exitCode?: number;
}

/**
 * The state of an eval computer, for cases where the bot may check its own earlier work. Shell
 * commands get output consistent with that state; screenshots show its browser window.
 */
export interface ComputerScript {
  /**
   * Checks the computer answers, most specific first: each command answers with the first one
   * it matches. A command none of them matches stays unavailable, as without a script.
   */
  shell: ScriptedCheck[];
  /** The browser window screenshots show: its title and whether its page renders dark. */
  screen: { title: string; dark: boolean };
}

/** Shell syntax this script cannot follow command by command (loops, substitutions, scripts). */
const COMPOUND =
  /\b(?:for|while|until|if|case|function)\b|\$\(|`|\b(?:python3?|node|perl|awk|sh|bash)\b/;
const SILENCED = /2>\s*\/dev\/null|2>&-|&>\s*\/dev\/null/;

/**
 * What the script answers for a shell command, or undefined when it covers none of it. A plain
 * command list (`;`, `&&`, `||`) runs command by command, so one unscripted command makes the
 * whole list unavailable; `echo` prints its words. Loops and inline scripts get the answers to
 * the checks they mention, in the order they mention them.
 */
export function scriptedShell(
  script: ComputerScript,
  command: string,
): { stdout: string; stderr: string; code: number } | undefined {
  const out: string[] = [];
  const err: string[] = [];
  const emit = (check: ScriptedCheck, silenced: boolean) => {
    const code = check.exitCode ?? 0;
    if (!check.output) return code;
    if (code === 0) out.push(check.output);
    else if (!silenced) err.push(check.output);
    return code;
  };
  if (COMPOUND.test(command)) {
    // A more specific check answers where it matches; a general one only where it alone does.
    const found: Array<{ check: ScriptedCheck; at: number }> = [];
    for (const check of script.shell) {
      const at = command.search(check.match);
      if (at >= 0 && !found.some((earlier) => earlier.at === at)) found.push({ check, at });
    }
    found.sort((a, b) => a.at - b.at);
    if (!found.length) return undefined;
    const codes = found.map(({ check }) => emit(check, SILENCED.test(command)));
    return { stdout: out.join("\n"), stderr: err.join("\n"), code: codes.at(-1)! };
  }
  const parts = command.split(/\s*(&&|\|\||;|\n)\s*/);
  let code = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index]!.trim();
    const operator = parts[index - 1];
    if (!part || (operator === "&&" && code !== 0) || (operator === "||" && code === 0)) continue;
    const echo = /^echo\s+(?:-[en]+\s+)?(.*)$/s.exec(part.replace(/\s*[|>].*$/s, ""));
    if (echo) {
      out.push(echo[1]!.replace(/^(["'])(.*)\1$/s, "$2"));
      code = 0;
      continue;
    }
    const check = script.shell.find((entry) => entry.match.test(part));
    if (!check) return undefined;
    code = emit(check, SILENCED.test(part));
  }
  return { stdout: out.join("\n"), stderr: err.join("\n"), code };
}

const SHELL_UNAVAILABLE = "Shell execution is unavailable in this offline eval sandbox.";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];
  private readonly screenImage?: Uint8Array;

  constructor(private readonly script?: ComputerScript) {
    super();
    if (script) this.screenImage = browserScreen(script.screen.dark);
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const command = request.argv.at(-1) ?? "";
      const result = this.script && scriptedShell(this.script, command);
      if (result) {
        if (result.stdout) yield { type: "stdout", data: `${result.stdout}\n` };
        if (result.stderr) yield { type: "stderr", data: `${result.stderr}\n` };
        yield { type: "exit", code: result.code };
        return;
      }
      if (!this.harnessIssues.includes(SHELL_UNAVAILABLE))
        this.harnessIssues.push(SHELL_UNAVAILABLE);
      yield { type: "stderr", data: SHELL_UNAVAILABLE };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }

  override async observe(computer: ComputerRef, context: AdapterContext) {
    if (!this.script || !this.screenImage) return super.observe(computer, context);
    return computerObservation(this.screenImage, {
      mimeType: "image/png",
      width: SCREEN.width,
      height: SCREEN.height,
      activeWindow: { id: "browser", title: this.script.screen.title },
    });
  }
}

const SCREEN = { width: 640, height: 400 };

/** A browser window: a toolbar, then a page of text lines, light or dark. */
function browserScreen(dark: boolean): Uint8Array {
  const png = new PNG(SCREEN);
  const page = dark ? [24, 24, 27] : [255, 255, 255];
  const text = dark ? [200, 200, 205] : [40, 40, 45];
  const toolbar = [222, 225, 230];
  for (let y = 0; y < SCREEN.height; y++) {
    for (let x = 0; x < SCREEN.width; x++) {
      const line = y >= 80 && (y - 80) % 24 < 8 && x >= 40 && x < 40 + 520 - ((y * 7) % 160);
      const [r, g, b] = y < 48 ? toolbar : line ? text : page;
      const i = (y * SCREEN.width + x) * 4;
      png.data[i] = r!;
      png.data[i + 1] = g!;
      png.data[i + 2] = b!;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}
