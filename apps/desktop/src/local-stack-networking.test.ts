import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allocateLoopbackPort, readStackWebUrl, STACK_WEB_URL_FILE } from "./local-stack.js";
import { DEFAULT_LOCAL_WEB_URL } from "./setup-config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "stack-networking-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("managed stack address", () => {
  it("keeps the desktop default separate from development", () => {
    expect(DEFAULT_LOCAL_WEB_URL).toBe("http://127.0.0.1:45173");
  });

  it("restores a previously selected loopback port", async () => {
    await writeFile(path.join(dir, STACK_WEB_URL_FILE), "http://127.0.0.1:49152");
    expect(await readStackWebUrl(dir, DEFAULT_LOCAL_WEB_URL)).toBe("http://127.0.0.1:49152");
  });

  it.each([
    "http://example.com:49152",
    "http://192.168.1.2:49152",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:01024",
    "http://127.0.0.1:80",
    "http://127.0.0.1:49152/path",
    "http://user:password@127.0.0.1:49152",
    "http://127.0.0.1:49152\n",
    "x".repeat(129),
  ])("rejects an invalid persisted origin: %s", async (url) => {
    await writeFile(path.join(dir, STACK_WEB_URL_FILE), url);
    expect(await readStackWebUrl(dir, DEFAULT_LOCAL_WEB_URL)).toBe(DEFAULT_LOCAL_WEB_URL);
  });

  it("does not follow a symlink to an address file", async () => {
    await writeFile(path.join(dir, "other"), "http://127.0.0.1:49152");
    await symlink(path.join(dir, "other"), path.join(dir, STACK_WEB_URL_FILE));
    expect(await readStackWebUrl(dir, DEFAULT_LOCAL_WEB_URL)).toBe(DEFAULT_LOCAL_WEB_URL);
  });

  it("allocates an unprivileged local port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
