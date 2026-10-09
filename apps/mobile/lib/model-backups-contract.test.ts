import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/(settings)/models.tsx", import.meta.url), "utf8");

describe("native backup editor loading contract", () => {
  it("requires a successful load before enabling edits or saving", () => {
    expect(source).toContain("const backupLocked = !backupReady || backupLoading || backupSaving;");
    expect(source).toContain("const backupReadyRef = useRef(false);");
    expect(source).toMatch(
      /function addBackupChoice[\s\S]*?if\s*\(\s*backupLoadingRef\.current\s*\|\|\s*!backupReadyRef\.current\s*\|\|\s*backupSavingRef\.current/,
    );
    expect(source).toMatch(/async function saveBackupModels[\s\S]*?!backupReadyRef\.current/);
  });

  it("invalidates pending picker callbacks before a replacement load", () => {
    const load = source.slice(
      source.indexOf("const loadBackupModels"),
      source.indexOf("useFocusEffect(", source.indexOf("const loadBackupModels")),
    );
    expect(load.indexOf("backupReadyRef.current = false")).toBeLessThan(
      load.indexOf("await captureApiRequestContext()"),
    );
    expect(load.indexOf("backupReadyRef.current = true")).toBeGreaterThan(
      load.indexOf('"models/backups"'),
    );
    expect(load.indexOf("setBackupReady(true)")).toBeGreaterThan(load.indexOf('"models/backups"'));
  });
});
