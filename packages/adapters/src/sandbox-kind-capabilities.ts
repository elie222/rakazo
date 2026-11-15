import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import type { SandboxKind } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import { appleContainerSandboxCapabilities } from "./apple-container-capabilities.js";
import { boatSandboxCapabilities } from "./boat-capabilities.js";
import { boxdSandboxCapabilities } from "./boxd-capabilities.js";
import { createosSandboxCapabilities } from "./createos-capabilities.js";
import { daytonaSandboxCapabilities } from "./daytona-capabilities.js";
import { desktopSandboxCapabilities } from "./desktop-capabilities.js";
import { dockerSandboxCapabilities } from "./docker-capabilities.js";
import { e2bSandboxCapabilities } from "./e2b-capabilities.js";
import { fakeSandboxCapabilities } from "./fake-capabilities.js";
import { incusSandboxCapabilities } from "./incus-capabilities.js";
import { instaboxSandboxCapabilities } from "./instabox-capabilities.js";
import { kubernetesSandboxCapabilities } from "./kubernetes-capabilities.js";
import { noneSandboxCapabilities } from "./none-capabilities.js";
import { novitaSandboxCapabilities } from "./novita-capabilities.js";
import { railwaySandboxCapabilities } from "./railway-capabilities.js";
import { wuyingSandboxCapabilities } from "./wuying-capabilities.js";

/** A kind with no entry here fails typecheck, so a new provider cannot skip its declaration. */
export const sandboxCapabilitiesByKind: Record<SandboxKind, SandboxKindCapabilities> = {
  none: noneSandboxCapabilities,
  docker: dockerSandboxCapabilities,
  e2b: e2bSandboxCapabilities,
  novita: novitaSandboxCapabilities,
  daytona: daytonaSandboxCapabilities,
  createos: createosSandboxCapabilities,
  boat: boatSandboxCapabilities,
  boxd: boxdSandboxCapabilities,
  instabox: instaboxSandboxCapabilities,
  railway: railwaySandboxCapabilities,
  kubernetes: kubernetesSandboxCapabilities,
  incus: incusSandboxCapabilities,
  "local-vm": appleContainerSandboxCapabilities,
  wuying: wuyingSandboxCapabilities,
  desktop: desktopSandboxCapabilities,
  fake: fakeSandboxCapabilities,
};

/** A stored kind no provider declares anymore reads as a plain remote Linux computer. */
const UNDECLARED_KIND_CAPABILITIES: SandboxKindCapabilities = {
  terminal: false,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: false,
  storedHomeIsBackup: false,
};

/**
 * Read by the computer's own kind, never from the deployment's provider: one deployment can
 * run computers of several kinds.
 */
export function sandboxKindCapabilities(kind: string | null | undefined): SandboxKindCapabilities {
  return kind && Object.hasOwn(sandboxCapabilitiesByKind, kind)
    ? sandboxCapabilitiesByKind[kind as SandboxKind]
    : UNDECLARED_KIND_CAPABILITIES;
}

export function sandboxKindsWhere(
  matches: (capabilities: SandboxKindCapabilities) => boolean,
): SandboxKind[] {
  return (Object.keys(sandboxCapabilitiesByKind) as SandboxKind[]).filter((kind) =>
    matches(sandboxCapabilitiesByKind[kind]),
  );
}
