import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

// The release runner's repository is the authority for the packaged update feed.
const repository = process.env.GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
  throw new Error("A valid release repository is required.");
}
const [owner, repo] = repository.split("/");
const verify = process.argv[2] === "--verify";
const file = process.argv[verify ? 3 : 2];
if (!file) throw new Error("A desktop configuration file is required.");
if (verify) {
  const feed = parse(readFileSync(file, "utf8"));
  if (feed?.provider !== "github" || feed.owner !== owner || feed.repo !== repo) {
    throw new Error("The packaged update feed does not match the release repository.");
  }
} else {
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config.build?.mac) throw new Error("Expected a desktop build configuration.");
  config.build.publish = [{ provider: "github", owner, repo }];
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
