import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { configPath, loadConfig, saveConfig } from "./config.js";

it("saves the key readable by this user only, even over an open file", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "rakazo-cli-"));
  const env = { XDG_CONFIG_HOME: base };
  try {
    const file = configPath(env);
    await mkdir(path.dirname(file), { mode: 0o755 });
    await writeFile(file, "{}", { mode: 0o644 });
    await saveConfig({ url: "https://rakazo.example.test", key: "rkz_key" }, env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await loadConfig(env)).toEqual({ url: "https://rakazo.example.test", key: "rkz_key" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
