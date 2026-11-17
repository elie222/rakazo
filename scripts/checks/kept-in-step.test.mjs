// Values two files must agree on where neither can import the other: another language, a
// stylesheet, a Compose file, or a package outside the other's dependency graph. Each pair reads
// both sides, so changing one alone fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The one capture of `pattern` in `file`; a missing or repeated match fails as a broken pair. */
function capture(file, pattern) {
  const text = readFileSync(path.join(root, file), "utf8");
  const matches = [...text.matchAll(new RegExp(pattern, `${pattern.flags.replace("g", "")}g`))];
  assert.equal(matches.length, 1, `${file} should match ${pattern} once; update this check`);
  return matches[0][1];
}

test("Android's recent-runs page size matches the API's", () => {
  assert.equal(
    capture(
      "apps/mobile/modules/rakazo-notifications/android/src/main/java/com/rakazo/notifications/RakazoNotificationService.kt",
      /const val RECENT_LIMIT = (\d+)/,
    ),
    capture("apps/api/src/runs.ts", /const RECENT_LIMIT = (\d+);/),
  );
});

test("iOS file drop finds the composer by its test id", () => {
  assert.equal(
    capture(
      "apps/mobile/modules/rakazo-file-drop/ios/RakazoFileDropModule.swift",
      /static let composerID = "([^"]+)"/,
    ),
    capture("apps/mobile/components/thread-composer.tsx", /testID="(chat-composer[^"]*)"/),
  );
});

test("the supervisor refuses a page browser request with the code adapters recognise", () => {
  assert.equal(
    capture("infra/sandboxes/supervisor/src/routes.ts", /code: "(invalid_browser_request)"/),
    capture(
      "packages/adapter-kit/src/sandbox-errors.ts",
      /export const INVALID_BROWSER_REQUEST = "([^"]+)";/,
    ),
  );
});

test("the updater's default project name is the one production Compose pins", () => {
  assert.equal(
    capture(
      "packages/core/src/deployment/compose-update.ts",
      /DEFAULT_COMPOSE_PROJECT_NAME = "([^"]+)";/,
    ),
    capture("infra/compose/docker-compose.prod.yml", /^name: (\S+)$/m),
  );
});

test("Kubernetes computers use the published Compose image repository", () => {
  const [image] = capture(
    "infra/compose/docker-compose.images.yml",
    /^ {4}image: (\$\{RAKAZO_COMPUTER_IMAGE:-[^}]+\}:\$\{RAKAZO_COMPUTER_IMAGE_TAG:-[^}]+\})$/m,
  )
    .match(/:-([^}]+)\}:\$\{RAKAZO_COMPUTER_IMAGE_TAG:-([^}]+)\}/)
    .slice(1);
  assert.equal(
    // Source/main deployments retain their development channel; published installs use stable.
    capture(
      "packages/adapters/src/providers/computer/kubernetes/kubernetes-sandbox.ts",
      /DEFAULT_COMPUTER_IMAGE = "([^"]+)";/,
    ).split(":")[0],
    image,
  );
});

test("table column widths are capped at the cell's own max-width", () => {
  assert.equal(
    `${capture("packages/chat-ui/src/table-utils.ts", /const MAX_WIDTH_CHARS = (\d+);/)}ch`,
    capture(
      "packages/chat-ui/src/markdown-table.css",
      /^\.rk-table-cell-text \{[^}]*max-width: (\S+);/m,
    ),
  );
});

test("Depot's pull request test workflow is the one GitHub runs on main", () => {
  const [depot, github] = [".depot", ".github"].map((folder) =>
    readFileSync(path.join(root, folder, "workflows/test-suites.yml"), "utf8"),
  );
  assert.ok(
    depot === github,
    "copy .github/workflows/test-suites.yml to .depot/workflows/test-suites.yml",
  );
});
