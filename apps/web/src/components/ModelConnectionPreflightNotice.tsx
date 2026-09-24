import { Trans } from "@lingui/react/macro";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import type { ReactNode } from "react";
import { SuccessPop } from "./ai/primitives";

export function ModelPreflightFeedback({
  success,
  failure,
}: {
  success: string | null;
  failure: ModelPreflightFailure | null;
}) {
  if (success) {
    return (
      <div className="mt-2" role="status">
        <SuccessPop label={success} />
      </div>
    );
  }
  if (!failure) return null;
  return (
    <div className="mt-2 space-y-1 text-[13px]" role="alert">
      <p className="text-destructive">{failure.message}</p>
      <p className="text-muted-foreground">{failure.nextAction}</p>
    </div>
  );
}

export function modelPreflightTestingLabel(testing: boolean): ReactNode {
  return testing ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>;
}
