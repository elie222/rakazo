import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSE_FILE,
  DEFAULT_UPDATER_PORT,
  readEnvAssignment,
  readTagState,
  resolveUpdaterConfig,
  truncateOutput,
} from "./updater-logic.js";

const base = { RAKAZO_DEPLOY_DIR: "/srv/rakazo", RAKAZO_UPDATER_TOKEN: "token" } as const;

describe("resolveUpdaterConfig", () => {
  it("derives the compose file, env file, and defaults from the deployment directory", () => {
    const config = resolveUpdaterConfig({ ...base });
    expect(config).toMatchObject({
      deployDir: "/srv/rakazo",
      composeFile: `/srv/rakazo/${DEFAULT_COMPOSE_FILE}`,
      envFile: "/srv/rakazo/.env",
      token: "token",
      port: DEFAULT_UPDATER_PORT,
    });
  });

  it("binds to loopback unless the deployment says otherwise, so a stray port is not a door", () => {
    expect(resolveUpdaterConfig({ ...base }).host).toBe("127.0.0.1");
    expect(resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("refuses a deployment directory that is missing or relative", () => {
    expect(() => resolveUpdaterConfig({ RAKAZO_UPDATER_TOKEN: "t" })).toThrow(/RAKAZO_DEPLOY_DIR/);
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_DEPLOY_DIR: "srv/rakazo" })).toThrow(
      /RAKAZO_DEPLOY_DIR/,
    );
  });

  it("refuses a compose path that escapes the deployment directory", () => {
    for (const composeFile of ["/etc/compose.yml", "../../etc/compose.yml", "a/../../b.yml"]) {
      expect(() => resolveUpdaterConfig({ ...base, RAKAZO_COMPOSE_FILE: composeFile })).toThrow(
        /RAKAZO_COMPOSE_FILE/,
      );
    }
  });

  it("refuses an image name it would not be willing to hand to compose", () => {
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_IMAGE: "Bad Name" })).toThrow(
      /RAKAZO_IMAGE/,
    );
    expect(resolveUpdaterConfig({ ...base, RAKAZO_IMAGE: "ghcr.io/me/app" }).image).toBe(
      "ghcr.io/me/app",
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_PORT: "0" })).toThrow(/port/);
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_PORT: "seven" })).toThrow(/port/);
  });
});

describe("readEnvAssignment", () => {
  it("reads the last assignment, ignoring comments and blank lines", () => {
    const contents = ["# RAKAZO_IMAGE_TAG=commented", "", "A=1", "A=2"].join("\n");
    expect(readEnvAssignment(contents, "A")).toBe("2");
    expect(readEnvAssignment(contents, "RAKAZO_IMAGE_TAG")).toBeNull();
  });

  it("removes one layer of quoting", () => {
    expect(readEnvAssignment('A="v1.0.0"', "A")).toBe("v1.0.0");
    expect(readEnvAssignment("A='v1.0.0'", "A")).toBe("v1.0.0");
  });

  it("does not match a key that merely shares a prefix", () => {
    expect(readEnvAssignment("RAKAZO_IMAGE_TAG_PREVIOUS=v1", "RAKAZO_IMAGE_TAG")).toBeNull();
  });
});

describe("readTagState", () => {
  it("reads the pinned tag and the rollback tag", () => {
    const contents = "RAKAZO_IMAGE_TAG=v1.1.0\nRAKAZO_IMAGE_TAG_PREVIOUS=v1.0.0\n";
    expect(readTagState(contents)).toEqual({ currentTag: "v1.1.0", previousTag: "v1.0.0" });
  });

  it("falls back to latest when nothing is pinned yet", () => {
    expect(readTagState("")).toEqual({ currentTag: "latest", previousTag: null });
  });

  it("ignores values in the file that are not usable tags", () => {
    const contents = "RAKAZO_IMAGE_TAG=-rm\nRAKAZO_IMAGE_TAG_PREVIOUS=$(id)\n";
    expect(readTagState(contents)).toEqual({ currentTag: "latest", previousTag: null });
  });
});

describe("truncateOutput", () => {
  it("keeps short output as-is and keeps the tail of long output", () => {
    expect(truncateOutput("done\n")).toBe("done");
    const long = truncateOutput("x".repeat(20_000));
    expect(long.startsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(9_000);
  });
});
