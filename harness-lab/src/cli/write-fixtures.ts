import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "../fixtures.js";

const f = buildFixtures();
for (const [name, value] of Object.entries(f)) {
  const path = fileURLToPath(new URL(`../../fixtures/${name}.json`, import.meta.url));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log("wrote", path);
}
