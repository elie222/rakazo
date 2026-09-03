import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const caddyfiles = ["Caddyfile.prod", "Caddyfile.cloudflare.example"];

describe.each(caddyfiles)("%s deployment retry", (filename) => {
  const config = readFileSync(path.join(composeDir, filename), "utf8");

  it("bounds retries while an application container is being recreated", () => {
    expect(config).toContain("(deploy_retry) {");
    expect(config).toContain("lb_try_duration 10s");
    expect(config).toContain("lb_try_interval 250ms");
  });

  it("applies the retry policy to every API and web upstream", () => {
    expect(config.match(/reverse_proxy api:3100 \{\s*import deploy_retry\s*\}/g)).toHaveLength(3);
    expect(config.match(/reverse_proxy web:5173 \{\s*import deploy_retry\s*\}/g)).toHaveLength(1);
  });
});
