import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  environment?: Record<string, unknown>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function loadCompose(rel: string) {
  return parse(readFileSync(path.resolve(repoRoot, rel), "utf8")) as {
    services: Record<string, ComposeService>;
  };
}

function expectProxyPassthrough(env: Record<string, unknown> | undefined) {
  expect(env?.HTTP_PROXY).toBe("${HTTP_PROXY:-${http_proxy:-}}");
  expect(env?.HTTPS_PROXY).toBe("${HTTPS_PROXY:-${https_proxy:-}}");
  expect(env?.NO_PROXY).toBe("${NO_PROXY:-${no_proxy:-}}");
  expect(env?.http_proxy).toBe("${http_proxy:-${HTTP_PROXY:-}}");
  expect(env?.https_proxy).toBe("${https_proxy:-${HTTPS_PROXY:-}}");
  expect(env?.no_proxy).toBe("${no_proxy:-${NO_PROXY:-}}");
}

describe("local and topology compose proxy passthrough", () => {
  it("passes optional HTTP(S)_PROXY / NO_PROXY into docker-compose.yml api/worker", () => {
    const compose = loadCompose("infra/compose/docker-compose.yml");
    for (const name of ["api", "worker"] as const) {
      expectProxyPassthrough(compose.services[name]?.environment);
    }
  });

  it("passes the same knobs through topology app-environment (api + worker)", () => {
    const compose = loadCompose("infra/compose/docker-compose.topology.yml");
    for (const name of ["api", "worker"] as const) {
      expectProxyPassthrough(compose.services[name]?.environment);
    }
  });
});
