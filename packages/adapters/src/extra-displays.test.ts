import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { observeExtraDisplayCommand, parseExtraDisplayObservation } from "./extra-displays.js";

const run = promisify(execFile);
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake X tools. scrot appends its display name in slow steps, so overlapping calls on a shared
 * file interleave, and writes enough bytes that the wrapping base64 below splits the output.
 */
function fakeTools() {
  const bin = mkdtempSync(path.join(tmpdir(), "rakazo-observe-bin-"));
  cleanups.push(bin);
  writeFileSync(
    path.join(bin, "scrot"),
    '#!/bin/sh\nfor i in 1 2 3 4 5; do head -c 100 /dev/zero | tr "\\0" "$DISPLAY_CHAR" >> "$2"; sleep 0.05; done\n',
  );
  writeFileSync(path.join(bin, "xdotool"), "#!/bin/sh\necho X=12\necho Y=34\n");
  // Wraps at 76 columns like GNU base64, whatever the host's base64 does.
  writeFileSync(
    path.join(bin, "base64"),
    `#!/bin/sh\nPATH=${JSON.stringify(process.env.PATH)} base64 "$@" | tr -d "\\n" | fold -w 76\n`,
  );
  for (const tool of ["scrot", "xdotool", "base64"]) chmodSync(path.join(bin, tool), 0o755);
  return bin;
}

describe("observing an extra display", () => {
  it("keeps overlapping screenshots of one display apart and removes them", async () => {
    const bin = fakeTools();
    // A display number no other test uses, so only this test's files are counted.
    const displayNumber = 90_000 + process.pid;
    const owned = () =>
      readdirSync("/tmp/rakazo").filter((name) => name.startsWith(`observe-${displayNumber}-`));
    mkdirSync("/tmp/rakazo", { recursive: true });
    const observe = (char: string) =>
      run("sh", ["-c", observeExtraDisplayCommand({ display: ":7", displayNumber })], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY_CHAR: char },
      });
    const outputs = await Promise.all([observe("a"), observe("b")]);
    for (const [index, char] of ["a", "b"].entries()) {
      const observed = parseExtraDisplayObservation(outputs[index]!.stdout);
      expect(Buffer.from(observed.image).toString()).toBe(char.repeat(500));
      expect(observed.cursor).toEqual({ x: 12, y: 34 });
    }
    expect(owned()).toEqual([]);
  });
});
