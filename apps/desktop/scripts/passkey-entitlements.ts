// Prints the main app's entitlements with the passkey association for a release signed by
// APPLE_TEAM_ID (read from the provisioning profile in CI, never committed). Helpers keep the
// base file: they are not the associated app.
import { readFileSync } from "node:fs";
import path from "node:path";
import { passkeyEntitlements } from "../src/passkeys.js";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  build: { appId: string; mac: { entitlements: string } };
};
const base = readFileSync(path.join(root, pkg.build.mac.entitlements), "utf8");
process.stdout.write(passkeyEntitlements(base, process.env.APPLE_TEAM_ID ?? "", pkg.build.appId));
