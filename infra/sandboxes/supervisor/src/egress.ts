import { getLogger } from "@rakazo/logging";
import type { ComputerEgressMode } from "./computer-spec.js";
import { COMPUTER_IMAGE } from "./computer-spec.js";
import {
  computerDns,
  computerEgressSetting,
  docker,
  ensureAttestImage,
  screenNetworkMode,
} from "./context.js";
import { EgressNotEnforced, verifyRestrictedEgress } from "./egress-probe.js";

// `auto` starts open and becomes restricted once the probe shows the host rules are in place.
export let computerEgressMode: ComputerEgressMode =
  computerEgressSetting === "restricted" ? "restricted" : "open";
// Enforcement is host-side (DOCKER-USER/INPUT on rakazo-c* bridges); the flag only
// names the interfaces. Refuse restricted computers until a probe shows the host
// rules are in place. `auto` keeps the first answer a completed probe gives:
// restricted when the rules are in place, otherwise open with a warning, which is
// how computers ran before the rules existed. A probe that could not finish
// decides nothing: the provision fails and the next one probes again. In both
// modes, once the rules are in place, a configured SANDBOX_COMPUTER_DNS that no
// server answers fails the provision the same way, so the next one probes again.
let autoEgressSettled: Promise<void> | undefined;
// One in-flight verification shared by concurrent provisions, never cached
// after it settles. The check is a precondition of every restricted start, so
// it cannot be bypassed; sharing it limits the one resource that needs
// limiting — each probe holds a network from the engine's small address pools —
// and each start is still covered by a check that finished after it arrived.
let egressVerification: Promise<void> | undefined;
async function verifyEgressNow() {
  egressVerification ??= verifyRestrictedEgress(
    docker,
    COMPUTER_IMAGE,
    computerDns,
    ensureAttestImage,
  ).finally(() => {
    egressVerification = undefined;
  });
  await egressVerification;
}

export async function ensureRestrictedEgressEnforced() {
  if (screenNetworkMode === "internal") return;
  if (computerEgressSetting === "auto") {
    const firstProbe = !autoEgressSettled;
    autoEgressSettled ??= verifyEgressNow().then(
      () => {
        computerEgressMode = "restricted";
        getLogger().info("restricted computer egress verified");
      },
      (error) => {
        if (!(error instanceof EgressNotEnforced)) {
          autoEgressSettled = undefined;
          throw error;
        }
        getLogger().warn("computer egress is open: the host firewall rules are not installed", {
          error: error.message,
        });
      },
    );
    await autoEgressSettled;
    if (!firstProbe && computerEgressMode === "restricted") {
      await verifyEgressNow();
    }
    return;
  }
  if (computerEgressMode !== "restricted") return;
  await verifyEgressNow();
}
