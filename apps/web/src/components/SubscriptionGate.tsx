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

const REFERRAL_CLAIM_WAIT_MS = 5_000;

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
    // Only the newest billing read may show, so a slow first read cannot undo the longer trial.
    let newest = 0;
    let shown = 0;
    fetchAuthCapabilities()
      .then(async (capabilities): Promise<GateState | null> => {
        if (!capabilities.billing) return { kind: "open" };
        const me = await loadMe();
        if (!me.billingEnabled) return { kind: "open" };
        // Claimed first, so an invited friend's status already offers the longer trial; a claim
        // that hangs never holds the app back for more than a few seconds.
        let claimed = false;
        const claim = claimStoredReferral().then(() => {
          claimed = true;
        });
        await Promise.race([
          claim,
          new Promise((resolve) => setTimeout(resolve, REFERRAL_CLAIM_WAIT_MS)),
        ]);
        // A slow claim that lands later refreshes billing, so the longer trial still shows.
        if (!claimed) {
          void claim.then(() => {
            const read = ++newest;
            return rpc.billing
              .status()
              .then((later) => {
                if (active && read === newest) {
                  shown = read;
                  setState(gateFor(later));
                }
              })
              .catch(() => undefined);
          });
        }
        const read = ++newest;
        const status = await rpc.billing.status();
        if (active && capabilities.crispWebsiteId) {
          setSupportChat({
            crispWebsiteId: capabilities.crispWebsiteId,
            email: me.email,
            name: me.name,
          });
        }
        // A later read already showed; keep it.
        return shown > read ? null : gateFor(status);
      })
      // A failure must not undo a newer read that already showed.
      .catch((): GateState | null => (shown > 0 ? null : { kind: "open" }))
      .then((next) => {
        if (active && next) setState(next);
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
