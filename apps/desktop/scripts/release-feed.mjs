import { readFileSync, writeFileSync } from "node:fs";

// The release runner's repository is the authority for the packaged update feed.
const repository = process.env.GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
  throw new Error("A valid release repository is required.");
}
const [owner, repo] = repository.split("/");
const file = process.argv[2];
if (!file) throw new Error("A desktop package file is required.");
const config = JSON.parse(readFileSync(file, "utf8"));
if (!config.build?.mac) throw new Error("Expected a desktop build configuration.");
config.build.publish = [{ provider: "github", owner, repo }];
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
