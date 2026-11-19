import { getLogger } from "@rakazo/logging";
import type { ComputerEgressMode } from "./computer-spec.js";
import { COMPUTER_IMAGE } from "./computer-spec.js";
import {
  computerDns,
  computerEgressSetting,
  docker,
  ensureComputerImage,
  screenNetworkMode,
} from "./context.js";
import { EgressNotEnforced, verifyRestrictedEgress } from "./egress-probe.js";

// `auto` starts open and becomes restricted once the probe shows the host rules are in place.
export let computerEgressMode: ComputerEgressMode =
  computerEgressSetting === "restricted" ? "restricted" : "open";
// Enforcement is host-side (DOCKER-USER/INPUT on rakazo-c* bridges); the flag only
// names the interfaces. Refuse restricted computers until a probe shows the host
// rules are in place. Only success is cached, so installing the rules needs no restart.
// `auto` keeps the first answer a completed probe gives: restricted when the rules are in place,
// otherwise open with a warning, which is how computers ran before the rules existed. A probe
// that could not finish decides nothing: the provision fails and the next one probes again.
// In both modes, once the rules are in place, a configured SANDBOX_COMPUTER_DNS that no server
// answers fails the provision the same way, so the next one probes again.
let egressAttempt: Promise<void> | undefined;
let egressCheck: "pending" | "verified" | "missing" | "failed" = "pending";

export async function ensureComputerEgress() {
  const needsCheck = screenNetworkMode !== "internal" && computerEgressSetting !== "open";
  try {
    await ensureComputerImage();
  } catch (error) {
    if (needsCheck && !egressAttempt) egressCheck = "failed";
    throw error;
  }
  if (!needsCheck) return;

  if (!egressAttempt) {
    egressCheck = "pending";
    egressAttempt = verifyRestrictedEgress(docker, COMPUTER_IMAGE, computerDns).then(
      () => {
        computerEgressMode = "restricted";
        egressCheck = "verified";
        getLogger().info("restricted computer egress verified");
      },
      (error) => {
        const missing = error instanceof EgressNotEnforced;
        egressCheck = missing ? "missing" : "failed";
        if (missing && computerEgressSetting === "auto") {
          getLogger().warn("computer egress is open: the host firewall rules are not installed", {
            error: error.message,
          });
          return;
        }
        egressAttempt = undefined;
        throw error;
      },
    );
  }
  await egressAttempt;
}

export function computerEgressReport() {
  const setting = `SANDBOX_COMPUTER_EGRESS=${computerEgressSetting}\n`;
  const rules = "Run infra/compose/restrict-computer-egress.sh on a supported Docker host.";
  if (screenNetworkMode === "internal") {
    return `${setting}Computers use a shared network. Per-computer egress is not verified.\n`;
  }
  if (computerEgressSetting === "open") {
    return `${setting}Open egress. Computers may reach the host, LAN and cloud metadata.\n`;
  }
  switch (egressCheck) {
    case "pending":
      return `${setting}Waiting for the host firewall check.\n`;
    case "verified":
      return `${setting}Restricted egress. The supervisor verified the host firewall rules.\n`;
    case "missing":
      if (computerEgressSetting === "auto") {
        return `${setting}Open egress fallback. Computers may reach the host, LAN and cloud metadata.\n${rules} Set SANDBOX_COMPUTER_EGRESS=restricted and recreate the supervisor to require the rules.\n`;
      }
      return `${setting}Computer starts are blocked because the host firewall rules could not be verified.\n${rules}\n`;
    case "failed":
      return `${setting}Egress check failed. See the supervisor logs for details.\n`;
  }
}
