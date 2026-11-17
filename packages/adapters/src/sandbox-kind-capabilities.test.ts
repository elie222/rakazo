import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { KnownSandboxKind } from "./sandbox-kind-capabilities.js";
import {
  isKnownSandboxKind,
  knownSandboxKinds,
  sandboxKindCapabilities,
  sandboxKindsWhere,
} from "./sandbox-kind-capabilities.js";

const DEFAULT_SCREEN = { width: 1280, height: 800 };
const LARGE_SCREEN = { width: 1920, height: 1080 };

type Row = [
  terminal: boolean,
  inPlaceUpdate: boolean,
  nativeShell: boolean,
  runsOnUserMachine: boolean,
  screen: { width: number; height: number },
  serverHomeMount: SandboxKindCapabilities["serverHomeMount"],
  serverOwnsStoredTeamHome: boolean,
  storedHomeIsBackup: boolean,
];

// What the per-kind id lists in shared code answered before providers declared these themselves,
// except boxd and railway: those lists had left out their terminal and stored team home.
const EXPECTED: Record<KnownSandboxKind, Row> = {
  none: [false, false, false, false, DEFAULT_SCREEN, "never", false, false],
  docker: [true, true, false, false, DEFAULT_SCREEN, "always", false, true],
  e2b: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  novita: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  daytona: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  createos: [false, true, false, false, DEFAULT_SCREEN, "never", true, false],
  boat: [true, true, false, false, LARGE_SCREEN, "never", true, false],
  boxd: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  instabox: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  railway: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  kubernetes: [true, true, false, false, DEFAULT_SCREEN, "optional", true, false],
  incus: [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  "local-vm": [true, true, false, false, DEFAULT_SCREEN, "never", true, false],
  wuying: [false, false, true, false, DEFAULT_SCREEN, "never", false, true],
  desktop: [false, false, true, true, DEFAULT_SCREEN, "never", false, true],
  fake: [true, true, false, false, DEFAULT_SCREEN, "never", false, false],
};
const UNDECLARED: Row = [false, true, false, false, DEFAULT_SCREEN, "never", false, false];

function capabilities([
  terminal,
  inPlaceUpdate,
  nativeShell,
  runsOnUserMachine,
  screen,
  serverHomeMount,
  serverOwnsStoredTeamHome,
  storedHomeIsBackup,
]: Row): SandboxKindCapabilities {
  return {
    terminal,
    inPlaceUpdate,
    nativeShell,
    runsOnUserMachine,
    screen,
    serverHomeMount,
    serverOwnsStoredTeamHome,
    storedHomeIsBackup,
  };
}

describe("sandbox kind capabilities", () => {
  it("declares every kind and no other", () => {
    expect([...knownSandboxKinds].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(knownSandboxKinds)("%s declares the pinned values", (kind) => {
    expect(sandboxKindCapabilities(kind)).toEqual(capabilities(EXPECTED[kind]));
  });

  it.each(["unknown", "", null, undefined])("reads undeclared kind %j as before", (kind) => {
    expect(sandboxKindCapabilities(kind)).toEqual(capabilities(UNDECLARED));
  });

  it("knows its own kinds and no other", () => {
    expect(isKnownSandboxKind("fake")).toBe(true);
    for (const kind of ["unknown", "", "toString", "__proto__", null, undefined])
      expect(isKnownSandboxKind(kind)).toBe(false);
  });

  it("lists the kinds with a capability", () => {
    expect(sandboxKindsWhere((entry) => entry.storedHomeIsBackup).sort()).toEqual([
      "desktop",
      "docker",
      "wuying",
    ]);
    expect(sandboxKindsWhere((entry) => entry.runsOnUserMachine)).toEqual(["desktop"]);
  });
});
