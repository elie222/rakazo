import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userProcesses } from "./processes.js";

let proc: string | undefined;
afterEach(async () => {
  if (proc) await rm(proc, { recursive: true, force: true });
  proc = undefined;
});

describe("user processes", () => {
  it("reads arguments, including from a title Chromium joined with spaces", async () => {
    proc = await mkdtemp(path.join(tmpdir(), "proc-"));
    await mkdir(path.join(proc, "self"));
    const fake = async (pid: string, cmdline: string) => {
      await mkdir(path.join(proc!, pid));
      await writeFile(path.join(proc!, pid, "comm"), "browser\n");
      await writeFile(
        path.join(proc!, pid, "status"),
        `Name:\tbrowser\nPPid:\t7\nUid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`,
      );
      await symlink("/opt/web/browser", path.join(proc!, pid, "exe"));
      await writeFile(path.join(proc!, pid, "cmdline"), cmdline);
    };
    await fake("10", "/opt/web/browser\0--flag\0a b\0");
    await fake("11", "/opt/web/browser --type=zygote --no-sandbox");
    await fake("12", "/opt/My App/app");
    const byPid = Object.fromEntries((await userProcesses(proc)).map((p) => [p.pid, p]));
    expect(byPid[10]).toEqual({
      pid: 10,
      ppid: 7,
      comm: "browser",
      exe: "/opt/web/browser",
      argv: ["/opt/web/browser", "--flag", "a b"],
    });
    expect(byPid[11]?.argv).toEqual(["/opt/web/browser", "--type=zygote", "--no-sandbox"]);
    expect(byPid[12]?.argv).toEqual(["/opt/My App/app"]);
  });
});
