import { useLingui } from "@lingui/react/macro";
import type { BillingStatus, Me } from "@rakazo/contracts";
import { Dialog, DialogContent } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { createContext, Suspense, useContext, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { peekInitialBootstrap } from "../lib/bootstrap";
import { lazyComponent } from "../lib/preload-recovery";
import { claimStoredReferral } from "../lib/referral";
import { rpc } from "../lib/rpc";
import type { SupportChat } from "../lib/support-chat";
import { useSupportChat } from "../lib/support-chat";

const PaywallPage = lazyComponent(() =>
  import("../pages/Paywall").then((module) => module.PaywallPage),
);

type GateState =
  | { kind: "loading" }
  | { kind: "open"; status?: BillingStatus }
  | { kind: "paywall"; status: BillingStatus };

const BillingContext = createContext<{ status: BillingStatus | null; showPlans: () => void }>({
  status: null,
  showPlans: () => undefined,
});

/** The latest billing status (`null` when the deployment does not bill) and the plan choice. */
export function useBilling() {
  return useContext(BillingContext);
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
  return { kind: status.access ? "open" : "paywall", status };
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
  const [supportChat, setSupportChat] = useState<SupportChat | null>(null);
  const { t } = useLingui();
  // `?plans` links straight to the plan choice.
  const [searchParams, setSearchParams] = useSearchParams();
  const plansOpen = searchParams.has("plans");
  const setPlansOpen = (open: boolean) =>
    setSearchParams((params) => {
      if (open) params.set("plans", "");
      else params.delete("plans");
      return params;
    });

  useEffect(() => {
    let active = true;
    fetchAuthCapabilities()
      .then(async (capabilities): Promise<GateState> => {
        if (!capabilities.billing) return { kind: "open" };
        const me = await loadMe();
        if (!me.billingEnabled) return { kind: "open" };
        void claimStoredReferral();
        const status = await rpc.billing.status();
        if (active && capabilities.crispWebsiteId) {
          setSupportChat({
            crispWebsiteId: capabilities.crispWebsiteId,
            email: me.email,
            name: me.name,
          });
        }
        return gateFor(status);
      })
      .catch((): GateState => ({ kind: "open" }))
      .then((next) => {
        if (active) setState(next);
      });
    return () => {
      active = false;
    };
  }, []);

  const billed = state.kind !== "loading" && state.status !== undefined;
  useEffect(() => {
    if (!billed) return;
    // Checkout can finish in another window (the system browser on desktop), and a free period
    // can end while the app is open.
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
  }, [billed]);

  // On the required paywall only: the plans dialog blocks pointer input outside itself.
  useSupportChat(state.kind === "paywall" ? supportChat : null);

  if (state.kind === "loading") return fallback;
  if (state.kind === "paywall") {
    return (
      <Suspense fallback={fallback}>
        <PaywallPage status={state.status} />
      </Suspense>
    );
  }
  return (
    <BillingContext.Provider
      value={{ status: state.status ?? null, showPlans: () => setPlansOpen(true) }}
    >
      {children}
      {state.status ? (
        // Over the app rather than replacing it, so closing keeps its state.
        <Dialog open={plansOpen} onOpenChange={setPlansOpen}>
          <DialogContent
            aria-label={t`Choose how to use Rakazo`}
            className="inset-0 top-0 left-0 block h-dvh max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none bg-background p-0 ring-0 sm:max-w-none"
          >
            <Suspense fallback={fallback}>
              <PaywallPage status={state.status} dismissible />
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </BillingContext.Provider>
  );
}
