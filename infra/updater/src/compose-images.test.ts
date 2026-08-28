import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: unknown;
  env_file?: unknown;
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: unknown[];
  user?: string;
  restart?: string;
}

const composeFile = path.resolve(import.meta.dirname, "../../compose/docker-compose.images.yml");
const compose = parse(readFileSync(composeFile, "utf8")) as {
  services: Record<string, ComposeService>;
};

const appServices = ["api", "worker", "web", "supervisor"] as const;

/**
 * The images compose file is the no-checkout happy path. It must stay pull-only and self-contained
 * so operators can drop it next to a .env outside any git worktree. Local Docker computers run via
 * an in-stack supervisor (app image + docker.sock) that stays unpublished on the host.
 */
describe("the images compose file", () => {
  it("runs postgres, app roles, supervisor, and a published computer image", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "computer",
      "data-init",
      "postgres",
      "supervisor",
      "web",
      "worker",
    ]);
    for (const service of appServices) {
      expect(compose.services[service]?.image).toContain("ghcr.io/elie222/rakazo/app");
      expect(compose.services[service]?.image).toContain("RAKAZO_IMAGE_TAG");
    }
    expect(compose.services.computer?.image).toContain("ghcr.io/elie222/rakazo/computer");
    expect(compose.services.computer?.image).toContain("RAKAZO_COMPUTER_IMAGE_TAG");
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

  it("defaults API and worker to Docker computers via the supervisor", () => {
    expect(compose.services.api?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.worker?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.api?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
    expect(compose.services.worker?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
  });

  it("keeps the Docker socket on the unpublished supervisor only", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      const hasSocket = (service.volumes ?? []).some((volume) => volume.includes("docker.sock"));
      if (name === "supervisor") {
        expect(hasSocket).toBe(true);
        expect(service.ports).toBeUndefined();
        expect(service.user).toBe("root");
        expect(String(service.command)).toContain("sandbox-supervisor");
      } else {
        expect(hasSocket).toBe(false);
      }
    }
  });

  it("publishes the web UI on loopback only", () => {
    expect(compose.services.web?.ports).toEqual(["127.0.0.1:5173:5173"]);
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.supervisor?.ports).toBeUndefined();
  });
});
