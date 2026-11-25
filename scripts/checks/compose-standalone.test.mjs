import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildStandalone, standalonePath } from "../../infra/compose/build-standalone.mjs";

test("docker-compose.standalone.yml matches the images Compose file and its overlay", () => {
  assert.equal(
    readFileSync(standalonePath, "utf8"),
    buildStandalone(),
    "Run `node infra/compose/build-standalone.mjs` and commit the result.",
  );
});
