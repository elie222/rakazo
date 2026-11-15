import { readFileSync } from "node:fs";

export const message =
  "Outside packages/adapters a provider id is an opaque string: do not name a vendor, branch on its id, or sniff a string only it produces. Name the capability instead, declare it in the provider's descriptor or capabilities in packages/adapters, and read labels, settings fields and defaults from the descriptor the server sends.";

export const include = [
  "{apps,packages,infra,scripts}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,prisma}",
];

export const exclude = [
  "packages/adapters/**",
  // Marketing pages may name vendors.
  "apps/www/**",
  "**/*.{test,spec}.*",
  "**/*test-support*",
  "**/e2e/**",
  "packages/testkit/**",
  "scripts/checks/ratchets/**",
  // Names a user picks by name are product data: model providers and protocols, messaging apps,
  // the integrations catalog, and the settings another agent's import reads.
  "packages/core/src/{model-providers,messaging-providers,featured-connectors,plugin-catalog}.ts",
  "packages/core/src/agent-import/**",
  // The monitoring and logging sinks, which lint also lets load their vendor's SDK.
  "{apps/desktop/src,apps/web/src/lib,apps/mobile/lib}/monitoring.ts",
  "packages/logging/src/{sentry,axiom,axiom-sink}.ts",
];

// Provider ids that are also ordinary words or name no vendor. A match outside adapters is
// rarely a vendor reference, so they are not checked: "none", "fake" and "desktop" are plain
// English, and Docker is the runtime self-hosting itself is built on.
const UNCHECKED_COMPUTER_IDS = new Set(["none", "fake", "desktop", "docker"]);

// Every computer provider declares its capabilities under its id, so a new one is checked
// from the pull request that adds it.
function computerProviderIds() {
  const source = readFileSync(
    new URL("../../../packages/adapters/src/sandbox-kind-capabilities.ts", import.meta.url),
    "utf8",
  );
  const declared = /sandboxCapabilitiesByKind[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  const ids = [...declared.matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((match) => match[1]);
  if (ids.length === 0) throw new Error("No computer provider ids found in packages/adapters");
  return ids.filter((id) => !UNCHECKED_COMPUTER_IDS.has(id));
}

// The other families have no registry to read, so their vendors are listed: the names in adapter
// file names and the SDKs in scripts/lazy-vendors.test.mjs. Left out on purpose: messaging apps
// and their gateways, model providers and model protocols, which are the carve-out above; open
// protocols and standards (S3, SMTP, APNs, OTLP); names that are ordinary words in code (resend,
// parallel, cursor, link, expo); and AWS, which shared code names only as a cloud metadata
// address to refuse and as a kind of model credential.
const VENDORS = [
  // Connectors
  "composio",
  "pipedream",
  // Memory
  "supermemory",
  "honcho",
  "hindsight",
  "serenity",
  // Voice
  "elevenlabs",
  "cartesia",
  "fish[-_ ]?audio",
  // Infrastructure: secrets, payments, monitoring, web search, and the SDKs computer providers
  // are reached through
  "infisical",
  "stripe",
  "sentry",
  "axiom(?:hq)?",
  "alicloud",
  "aliyun",
  "alibaba",
  "darabonba",
  "keenable",
  "boatdev",
  "insforge",
];

const names = [...computerProviderIds(), ...VENDORS].join("|");

// A name counts as a whole word or a whole part of an identifier, in any casing:
// "acme", "ACME_API_KEY", "acmeClient" and "liveAcmeUrl" all name Acme; "acmeology" does not.
export const pattern = new RegExp(
  `(?:(?<![A-Za-z0-9])|(?<=[a-z])(?=[A-Z]))(?i:${names})(?![a-z0-9])`,
  "g",
);
