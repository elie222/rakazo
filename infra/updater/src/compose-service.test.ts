import { readFileSync } from "node:fs";
import path from "node:path";
import { RECREATED_SERVICES } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: unknown[];
  networks?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  env_file?: unknown;
  command?: unknown;
  user?: string;
}

const composeFile = path.resolve(import.meta.dirname, "../../compose/docker-compose.prod.yml");
const compose = parse(readFileSync(composeFile, "utf8")) as {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
};
const updater = compose.services.updater as ComposeService;

/**
 * The updater holds the Docker socket, which is root-equivalent on the host. These are the
 * properties that keep that from being reachable by anything but the API, and they are easy to
 * break by accident in YAML, so they are asserted rather than reviewed.
 */
describe("the updater compose service", () => {
  it("exists and runs the updater image", () => {
    expect(updater).toBeDefined();
    expect(updater.image).toMatch(/updater/);
  });

  it("is opt-in because it grants root-equivalent Docker access", () => {
    expect(updater.profiles).toEqual(["updater"]);
  });

  it("publishes nothing on the host", () => {
    expect(updater.ports).toBeUndefined();
  });

  it("shares a dedicated control network with the API and not Caddy", () => {
    expect(updater.networks).toEqual(["control"]);
    expect(compose.services.api?.networks).toContain("control");
    expect(compose.services.caddy?.networks).not.toContain("control");
    expect(compose.networks).toHaveProperty("control");
  });

  it("is the only service holding the Docker socket", () => {
    const withSocket = Object.entries(compose.services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("docker.sock")),
      )
      .map(([name]) => name);
    expect(withSocket).toEqual(["updater"]);
  });

  it("is bind-mounted at the same path it has on the host", () => {
    const mount = (updater.volumes ?? []).find((volume) => volume.includes("RAKAZO_DEPLOY_DIR"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    const deployDir = "${RAKAZO_DEPLOY_DIR:-/srv/rakazo}";
    const separatorIndex = mount?.indexOf("}:${") ?? -1;
    const source = separatorIndex < 0 ? undefined : mount?.slice(0, separatorIndex + 1);
    const destination = separatorIndex < 0 ? undefined : mount?.slice(separatorIndex + 2);
    expect(updater.environment?.RAKAZO_DEPLOY_DIR).toBe(deployDir);
    expect(mount).toBe(`${deployDir}:${deployDir}`);
    expect(source).toBe(destination);
  });

  it("is not one of the services an update recreates", () => {
    expect(RECREATED_SERVICES).not.toContain("updater");
    for (const service of RECREATED_SERVICES) {
      expect(Object.keys(compose.services)).toContain(service);
    }
  });

  it("pins its own image tag separately from the application image", () => {
    expect(updater.image).toContain("RAKAZO_UPDATER_IMAGE_TAG");
    for (const service of RECREATED_SERVICES) {
      expect(compose.services[service]?.image).toContain("RAKAZO_IMAGE_TAG");
    }
  });

  it("uses the official registry namespace and digest-pins third-party runtime images", () => {
    expect(updater.image).toContain("ghcr.io/elie222/rakazo/updater");
    expect(compose.services.api?.image).toContain("ghcr.io/elie222/rakazo/app");
    expect(compose.services.postgres?.image).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
    expect(compose.services.caddy?.image).toMatch(/^caddy:2@sha256:[0-9a-f]{64}$/);
  });

  it("injects the actual Compose project name into the updater container", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.COMPOSE_PROJECT_NAME).toBe("${COMPOSE_PROJECT_NAME:-rakazo-prod}");
  });

  it("does not load the application env_file into the root-equivalent process", () => {
    expect(updater.env_file).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.RAKAZO_UPDATER_TOKEN).toBe("${RAKAZO_UPDATER_TOKEN:-}");
  });

  it("does not let the api container reach the Docker socket to update itself", () => {
    expect(compose.services.api?.volumes ?? []).not.toContain("/var/run/docker.sock");
    expect(compose.services.api?.environment?.RAKAZO_UPDATER_URL).toBe("http://updater:7092");
  });
});
