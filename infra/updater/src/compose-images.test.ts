import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  build?: unknown;
  env_file?: unknown;
  volumes?: string[];
  ports?: unknown[];
}

const composeFile = path.resolve(import.meta.dirname, "../../compose/docker-compose.images.yml");
const compose = parse(readFileSync(composeFile, "utf8")) as {
  services: Record<string, ComposeService>;
};

const appServices = ["api", "worker", "web"] as const;

/**
 * The images compose file is the no-checkout happy path. It must stay pull-only and self-contained
 * so operators can drop it next to a .env outside any git worktree.
 */
describe("the images compose file", () => {
  it("runs postgres and the three app roles from published images", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["api", "postgres", "web", "worker"]);
    for (const service of appServices) {
      expect(compose.services[service]?.image).toContain("ghcr.io/elie222/rakazo/app");
      expect(compose.services[service]?.image).toContain("RAKAZO_IMAGE_TAG");
    }
    expect(compose.services.postgres?.image).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
  });

  it("never builds from a checkout", () => {
    for (const service of Object.values(compose.services)) {
      expect(service.build).toBeUndefined();
    }
  });

  it("loads secrets from a colocated .env", () => {
    expect(compose.services.api?.env_file).toEqual([".env"]);
    expect(compose.services.worker?.env_file).toEqual([".env"]);
  });

  it("does not attach a Docker socket", () => {
    for (const service of Object.values(compose.services)) {
      expect((service.volumes ?? []).some((volume) => volume.includes("docker.sock"))).toBe(false);
    }
  });

  it("publishes the web UI on loopback only", () => {
    expect(compose.services.web?.ports).toEqual(["127.0.0.1:5173:5173"]);
    expect(compose.services.postgres?.ports).toBeUndefined();
  });
});
