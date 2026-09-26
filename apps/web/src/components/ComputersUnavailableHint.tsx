import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import {
  classifySandboxProvider,
  computersAreUnavailable,
  refreshSandboxFromServer,
  type SandboxAvailabilityPhase,
  sandboxCheckFailureMessage,
  sandboxEnvGuidanceText,
} from "../lib/computer-sandbox";
import { SuccessPop } from "./ai/primitives";

export { computersAreUnavailable } from "../lib/computer-sandbox";

type ComputersUnavailableHintProps = {
  className?: string;
  sandboxProvider?: string | null;
  /** When set, shows a control that opens Settings → Computer. */
  onOpenComputerSettings?: () => void;
  /** Called when a check finds computers available again. */
  onRecovered?: (sandboxProvider: string) => void;
  /** When false, hides Check again (e.g. inline preview without actions). */
  showRetry?: boolean;
};

export function ComputersUnavailableHint({
  className,
  sandboxProvider: initialProvider,
  onOpenComputerSettings,
  onRecovered,
  showRetry = true,
}: ComputersUnavailableHintProps) {
  const { t } = useLingui();
  const [provider, setProvider] = useState(initialProvider);
  const [phase, setPhase] = useState<SandboxAvailabilityPhase>("idle");
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setProvider(initialProvider);
  }, [initialProvider]);

  useEffect(() => {
    if (phase !== "recovered") return;
    const timer = setTimeout(() => setPhase("idle"), 4000);
    return () => clearTimeout(timer);
  }, [phase]);

  const unavailable = computersAreUnavailable(provider);
  const kind = classifySandboxProvider(provider);

  async function handleCheckAgain() {
    if (phase === "loading") return;
    setPhase("loading");
    setFailureMessage(null);
    try {
      const me = await refreshSandboxFromServer();
      setProvider(me.sandboxProvider);
      if (computersAreUnavailable(me.sandboxProvider)) {
        setPhase("unavailable");
        return;
      }
      setPhase("recovered");
      onRecovered?.(me.sandboxProvider);
    } catch (error) {
      setPhase("failure");
      setFailureMessage(sandboxCheckFailureMessage(error));
      // Do not treat stale cached provider as authoritative after a failed check.
      setProvider(null);
    }
  }

  async function handleCopyGuidance() {
    const text = sandboxEnvGuidanceText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const showUnavailableCopy = phase === "idle" || phase === "unavailable" || phase === "failure";

  return (
    <div
      data-testid="computers-unavailable-hint"
      className={className}
      role={phase === "failure" ? "alert" : undefined}
    >
      {phase === "loading" ? (
        <p className="text-[13px] text-muted-foreground" role="status">
          <Trans>Checking computer setup…</Trans>
        </p>
      ) : null}

      {phase === "recovered" ? (
        <SuccessPop label={t`Computers are available. Reload or open a bot to continue.`} />
      ) : null}

      {showUnavailableCopy ? <UnavailableCopy kind={kind} failureMessage={failureMessage} /> : null}

      {showRetry && (unavailable || phase === "failure") ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={phase === "loading"}
            onClick={() => void handleCheckAgain()}
          >
            {phase === "loading" ? <Trans>Checking…</Trans> : <Trans>Check again</Trans>}
          </Button>
          {onOpenComputerSettings ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={onOpenComputerSettings}
            >
              <Trans>Open computer settings</Trans>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => void handleCopyGuidance()}
          >
            {copied ? <Trans>Copied</Trans> : <Trans>Copy .env example</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function UnavailableCopy({
  kind,
  failureMessage,
}: {
  kind: ReturnType<typeof classifySandboxProvider>;
  failureMessage: string | null;
}) {
  if (failureMessage) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        <Trans>
          Could not verify computer setup ({failureMessage}). Fix the connection, then check again.
        </Trans>
      </p>
    );
  }

  if (kind === "docker") {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        <Trans>
          Docker is configured but computers are not responding. Confirm the sandbox supervisor is
          running, then recreate the stack after changing .env.
        </Trans>
      </p>
    );
  }

  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      <Trans>
        Computers are off. Set SANDBOX_PROVIDER=docker with SANDBOX_SUPERVISOR_TOKEN, or set
        SANDBOX_PROVIDER to e2b, daytona, or box with its API key. Recreate the stack after changing
        .env.
      </Trans>
    </p>
  );
}
