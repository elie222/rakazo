import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  entrypoint?: string[];
  volumes?: string[];
}

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const standaloneText = readFileSync(path.join(composeDir, "docker-compose.standalone.yml"), "utf8");
const standalone = parse(standaloneText) as { services: Record<string, ComposeService> };
const overlay = parse(
  readFileSync(path.join(composeDir, "docker-compose.standalone.overlay.yml"), "utf8"),
) as { "x-generated-secrets": string };

describe("the standalone compose file", () => {
  it("requires no variable, so it starts without a .env", () => {
    expect(standaloneText).not.toMatch(/\$\{[A-Z0-9_]+:?\?/);
  });

  it("gives each service only the generated secrets it receives, through its own volume", () => {
    const services = new Set(
      overlay["x-generated-secrets"]
        .split(" ")
        .flatMap((entry) => entry.split(":")[2]?.split(",") ?? []),
    );
    for (const name of services) {
      const service = standalone.services[name];
      expect(standalone.services.secrets?.volumes).toContain(`secrets-${name}:/services/${name}`);
      expect(service?.volumes).toContain(`secrets-${name}:/run/rakazo-secrets:ro`);
      expect(service?.entrypoint?.slice(0, 2)).toEqual(["sh", "/run/rakazo-secrets/start"]);
    }
    for (const [name, service] of Object.entries(standalone.services)) {
      if (name === "secrets") continue;
      expect(service.volumes ?? []).not.toContainEqual(expect.stringMatching(/^secrets:/));
    }
  });
});
