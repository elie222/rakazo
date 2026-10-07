import type { BillingStatus, Me } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { peekInitialBootstrap } from "../lib/bootstrap";
import { rpc } from "../lib/rpc";

const PaywallPage = lazy(() =>
  import("../pages/Paywall").then((module) => ({ default: module.PaywallPage })),
);

type GateState =
  | { kind: "loading" }
  | { kind: "open" }
  | { kind: "paywall"; status: BillingStatus };

let billingCapability: Promise<boolean> | undefined;

/** Public and DB-free, so a deployment without billing opens without waiting on bootstrap. */
function deploymentBills(): Promise<boolean> {
  billingCapability ??= fetchAuthCapabilities()
    .then((capabilities) => capabilities.billing === true)
    .catch(() => false);
  return billingCapability;
}

function loadMe(): Promise<Me> {
  const primed = peekInitialBootstrap();
  if (!primed) return rpc.me();
  return primed.then(
    (bootstrap) => bootstrap.me,
    () => rpc.me(),
  );
}

function gateFor(status: BillingStatus): GateState {
  return status.access ? { kind: "open" } : { kind: "paywall", status };
}

/**
 * Holds the app behind the paywall when the deployment bills. Self-hosted
 * installs only make the capabilities request. Enforcement belongs to the API,
 * so a failed lookup here falls through to the app.
 */
export function SubscriptionGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    deploymentBills()
      .then(async (bills): Promise<GateState> => {
        if (!bills || !(await loadMe()).billingEnabled) return { kind: "open" };
        return gateFor(await rpc.billing.status());
      })
      .catch((): GateState => ({ kind: "open" }))
      .then((next) => {
        if (active) setState(next);
      });
    return () => {
      active = false;
    };
  }, []);

  const paywalled = state.kind === "paywall";
  useEffect(() => {
    if (!paywalled) return;
    // Checkout can finish in another window (the system browser on desktop).
    let active = true;
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      rpc.billing
        .status()
        .then((status) => {
          if (active) setState(gateFor(status));
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      active = false;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [paywalled]);

  if (state.kind === "loading") return fallback;
  if (state.kind === "paywall") {
    return (
      <Suspense fallback={fallback}>
        <PaywallPage status={state.status} />
      </Suspense>
    );
  }
  return children;
}
