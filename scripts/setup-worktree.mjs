import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const root = git("rev-parse", "--show-toplevel").replace(/\r?\n$/, "");
// Git lists the primary checkout first, regardless of which branch it has checked out.
const main = git("worktree", "list", "--porcelain", "-z")
  .split("\0", 1)[0]
  .slice("worktree ".length);
const source = path.join(main, ".env");
const destination = path.join(root, ".env");

if (root !== main && existsSync(source)) {
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    console.log("Keeping this worktree's existing .env.");
    process.exit(0);
  }
  // Never copy secrets to a path Git would track, or replace a worktree's own settings.
  execFileSync("git", ["check-ignore", "-q", destination]);
  try {
    writeFileSync(destination, readFileSync(source), { flag: "wx", mode: 0o600 });
    console.log("Copied the main checkout's .env to this worktree.");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Keeping this worktree's existing .env.");
  }
}
