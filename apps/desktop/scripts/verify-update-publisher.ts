// Fails unless the packaged update config at argv[2] is bound to the signing publisher argv[3].
import { readFileSync } from "node:fs";
import { updateConfigBindsPublisher } from "../src/update-publisher.js";

const [config = "", publisher = ""] = process.argv.slice(2);
if (!updateConfigBindsPublisher(readFileSync(config, "utf8"), publisher)) {
  console.error("Windows update config is not bound to the signing publisher.");
  process.exit(1);
}
