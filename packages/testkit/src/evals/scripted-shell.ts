// Pure command scripting for eval computers. It must not import runtime packages: listing eval
// cases loads it before the database client is generated.

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
    // Each check is silenced only by a redirect before the next check, not by one elsewhere.
    const codes = found.map(({ check, at }, index) =>
      emit(check, SILENCED.test(command.slice(at, found[index + 1]?.at ?? command.length))),
    );
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
