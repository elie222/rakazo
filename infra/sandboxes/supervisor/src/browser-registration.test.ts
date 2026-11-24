import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("computer image browser registration", () => {
  it.skipIf(process.platform === "win32")(
    "skips the slow browser registration only when the image's defaults already apply",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const start = readFileSync(path.join(root, "start.sh"), "utf8");
      const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
      expect(dockerfile).toMatch(/COPY --chmod=644 mimeapps\.list \/etc\/xdg\/mimeapps\.list/);
      const check = start.match(/browser_handlers_set\(\) \{[\s\S]*?\n\}\n/)?.[0];
      expect(check).toBeDefined();
      expect(start).toMatch(/if ! browser_handlers_set; then\n\s+register_browser_handler/);
      const dir = mkdtempSync(path.join(tmpdir(), "rakazo-mimeapps-"));
      try {
        const home = path.join(dir, "home");
        const system = path.join(dir, "system-mimeapps.list");
        mkdirSync(path.join(home, ".config"), { recursive: true });
        const user = path.join(home, ".config", "mimeapps.list");
        const run = (env: Record<string, string> = {}) =>
          spawnSync(
            "bash",
            [
              "-uc",
              `AGENT_HOME=${JSON.stringify(home)}\n${check?.replace("/etc/xdg/mimeapps.list", JSON.stringify(system))}\nbrowser_handlers_set`,
            ],
            {
              encoding: "utf8",
              timeout: 5_000,
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
            },
          ).status;
        // No image defaults: register as before.
        expect(run()).toBe(1);
        copyFileSync(path.join(root, "mimeapps.list"), system);
        expect(run()).toBe(0);
        expect(run({ BROWSER: "firefox" })).toBe(1);
        expect(run({ XDG_CONFIG_HOME: path.join(dir, "elsewhere") })).toBe(1);
        expect(run({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(1);
        // A user file that leaves these types alone keeps the image's defaults.
        writeFileSync(user, "[Default Applications]\napplication/pdf=viewer.desktop\n");
        expect(run()).toBe(0);
        writeFileSync(
          user,
          "[Default Applications]\nx-scheme-handler/http=rakazo-browser.desktop\ntext/html=rakazo-browser.desktop;\n",
        );
        expect(run()).toBe(0);
        // Another browser for any of them is put back by the registration.
        writeFileSync(user, "[Default Applications]\nx-scheme-handler/https=firefox.desktop\n");
        expect(run()).toBe(1);
        writeFileSync(user, "[Added Associations]\ntext/html=firefox.desktop\n");
        expect(run()).toBe(0);
        writeFileSync(user, "[Default Applications]\ntext/html = firefox.desktop\n");
        expect(run()).toBe(1);
        writeFileSync(user, "[Removed Associations]\ntext/html=rakazo-browser.desktop\n");
        expect(run()).toBe(1);
        writeFileSync(
          user,
          "[Default Applications]\nx-scheme-handler/about=firefox.desktop\n[Added Associations]\n",
        );
        expect(run()).toBe(1);
        rmSync(user);
        symlinkSync(system, user);
        expect(run()).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
