// Writes docker-compose.standalone.yml: docker-compose.images.yml with the standalone overlay
// merged in, as one file a server panel can fetch by URL. Variables stay unexpanded, as
// `docker compose config --no-interpolate` would leave them, so the panel's environment fills
// them at start. scripts/checks/compose-standalone.test.mjs fails when the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const { parse, stringify } = createRequire(path.join(root, "infra/updater/package.json"))("yaml");

export const standalonePath = path.join(here, "docker-compose.standalone.yml");

const header = `# Generated from docker-compose.images.yml and docker-compose.standalone.overlay.yml by
# \`node infra/compose/build-standalone.mjs\`. Do not edit.
# Starts with no .env: the first start generates the secrets (docs/self-host.md#from-a-docker-panel).
`;

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const volumeTarget = (volume) => volume.split(":")[1];

// Compose's merge rules for the keys the overlay uses: maps merge by key, a command or entrypoint
// replaces the base one, and a service's volumes merge by mount target.
function mergeService(name, base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "command" || key === "entrypoint" || !(key in base)) {
      merged[key] = value;
    } else if (key === "volumes") {
      const targets = new Set(value.map(volumeTarget));
      merged.volumes = [...base.volumes.filter((v) => !targets.has(volumeTarget(v))), ...value];
    } else if (isMap(base[key]) && isMap(value)) {
      merged[key] = { ...base[key], ...value };
    } else {
      throw new Error(`build-standalone: merging services.${name}.${key} is not supported`);
    }
  }
  return merged;
}

export function buildStandalone() {
  const read = (file) => parse(readFileSync(path.join(here, file), "utf8"), { merge: true });
  const base = read("docker-compose.images.yml");
  const overlay = read("docker-compose.standalone.overlay.yml");

  // The updater rewrites an installer's deploy folder and .env, which a panel install has neither of.
  const { updater: _updater, ...services } = base.services;
  for (const [name, service] of Object.entries(overlay.services)) {
    services[name] = services[name] ? mergeService(name, services[name], service) : service;
  }
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("x-")) continue;
    merged[key] = value;
  }
  merged.services = services;
  const { control: _control, ...networks } = base.networks;
  merged.networks = networks;
  merged.volumes = { ...base.volumes, ...overlay.volumes };

  return (
    header +
    stringify(merged, {
      aliasDuplicateObjects: false,
      compat: "yaml-1.1",
      lineWidth: 0,
      nullStr: "",
    })
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(standalonePath, buildStandalone());
}
