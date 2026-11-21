import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { shellQuote } from "../computers/screens/computer-support.js";
import {
  installAgentBrowserCommand,
  installPageBrowserFilesCommand,
  privatePageInput,
} from "./page-browser-install.js";

const computer = path.resolve(import.meta.dirname, "../../../../infra/sandboxes/computer");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Runs a setup script with /usr/local moved under a scratch folder and no sudo. */
function runUnder(script: string, folder: string) {
  return execFileSync(
    "bash",
    ["-c", script.replaceAll("/usr/local", `${folder}/usr/local`).replaceAll('"sudo -n"', '""')],
    { encoding: "utf8" },
  );
}

it("writes this release's page-browser files once, and again when they differ", () => {
  root = mkdtempSync(path.join(tmpdir(), "page-browser-install-"));
  execFileSync("mkdir", ["-p", `${root}/usr/local/bin`]);
  const wrapper = `${root}/usr/local/bin/rakazo-page-browser`;
  const secrets = `${root}/usr/local/lib/rakazo/page_secrets.py`;

  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(wrapper, "utf8")).toBe(
    readFileSync(path.join(computer, "rakazo-page-browser"), "utf8"),
  );
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
  expect(readFileSync(`${root}/usr/local/lib/rakazo/page_passkey.py`, "utf8")).toBe(
    readFileSync(path.join(computer, "page_passkey.py"), "utf8"),
  );
  expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  expect(statSync(secrets).mode & 0o777).toBe(0o644);

  // A computer already on this release keeps its files untouched.
  writeFileSync(secrets, "edited");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe("edited");

  // One from another release gets this release's copy.
  writeFileSync(`${root}/usr/local/lib/rakazo/page-browser.version`, "older");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
});

it("installs agent-browser with the computer image's pinned script", () => {
  expect(installAgentBrowserCommand()).toContain(
    shellQuote(readFileSync(path.join(computer, "install-agent-browser.sh"), "utf8")),
  );
});

it("hands a page request to the helper from a folder only the computer user can open, gone before the helper reads it", () => {
  const input = privatePageInput();
  const folder = path.dirname(input.file);
  try {
    execFileSync("bash", ["-c", input.create]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(input.file).mode & 0o777).toBe(0o600);
    // As a hosted computer's file write fills it.
    writeFileSync(input.file, '{"command":"act","privateKey":"fake-passkey-key"}\n');
    expect(statSync(input.file).mode & 0o777).toBe(0o600);
    const seen = execFileSync(
      "bash",
      [
        "-c",
        input.run(`test ! -e ${shellQuote(input.file)} && test ! -e ${shellQuote(folder)} && cat`),
      ],
      { encoding: "utf8" },
    );
    expect(seen).toContain("fake-passkey-key");
    expect(existsSync(input.file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
