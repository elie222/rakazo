import { appleContainerComputer } from "./apple-container-computer.js";
import { boatComputer } from "./boat-computer.js";
import { boxdComputer } from "./boxd-computer.js";
import type { ComputerProviderDefinition } from "./computer-provider-descriptor.js";
import { createosComputer } from "./createos-computer.js";
import { daytonaComputer } from "./daytona-computer.js";
import { desktopComputer } from "./desktop-computer.js";
import { dockerComputer } from "./docker-computer.js";
import { e2bComputer } from "./e2b-computer.js";
import { fakeComputer } from "./fake-computer.js";
import { incusComputer } from "./incus-computer.js";
import { instaboxComputer } from "./instabox-computer.js";
import { kubernetesComputer } from "./kubernetes-computer.js";
import { noneComputer } from "./none-computer.js";
import { novitaComputer } from "./novita-computer.js";
import { railwayComputer } from "./railway-computer.js";
import { wuyingComputer } from "./wuying-computer.js";

/**
 * Every computer provider this build has, by id. The factory, the environment, Settings, kind
 * capabilities and the conformance fixtures all read from here. Settings lists them in this order.
 */
export const computerProviders = {
  none: noneComputer,
  docker: dockerComputer,
  wuying: wuyingComputer,
  e2b: e2bComputer,
  novita: novitaComputer,
  daytona: daytonaComputer,
  createos: createosComputer,
  boat: boatComputer,
  boxd: boxdComputer,
  instabox: instaboxComputer,
  railway: railwayComputer,
  kubernetes: kubernetesComputer,
  incus: incusComputer,
  "local-vm": appleContainerComputer,
  desktop: desktopComputer,
  fake: fakeComputer,
} satisfies Record<string, ComputerProviderDefinition>;

/** A kind this build has a provider for. Outside adapters a kind is an opaque string. */
export type KnownSandboxKind = keyof typeof computerProviders;

export const knownSandboxKinds = Object.keys(computerProviders) as KnownSandboxKind[];

export function isKnownSandboxKind(kind: string | null | undefined): kind is KnownSandboxKind {
  return !!kind && Object.hasOwn(computerProviders, kind);
}
