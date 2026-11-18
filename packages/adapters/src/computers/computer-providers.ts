import { boatComputer } from "../providers/computer/boat/boat-computer.js";
import { boxdComputer } from "../providers/computer/boxd/boxd-computer.js";
import { createosComputer } from "../providers/computer/createos/createos-computer.js";
import { daytonaComputer } from "../providers/computer/daytona/daytona-computer.js";
import { desktopComputer } from "../providers/computer/desktop/desktop-computer.js";
import { dockerComputer } from "../providers/computer/docker/docker-computer.js";
import { e2bComputer } from "../providers/computer/e2b/e2b-computer.js";
import { fakeComputer } from "../providers/computer/fake/fake-computer.js";
import { incusComputer } from "../providers/computer/incus/incus-computer.js";
import { instaboxComputer } from "../providers/computer/instabox/instabox-computer.js";
import { kubernetesComputer } from "../providers/computer/kubernetes/kubernetes-computer.js";
import { appleContainerComputer } from "../providers/computer/local-vm/apple-container-computer.js";
import { noneComputer } from "../providers/computer/none/none-computer.js";
import { novitaComputer } from "../providers/computer/novita/novita-computer.js";
import { railwayComputer } from "../providers/computer/railway/railway-computer.js";
import { wuyingComputer } from "../providers/computer/wuying/wuying-computer.js";
import type { ComputerProviderDefinition } from "./computer-provider-descriptor.js";

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
