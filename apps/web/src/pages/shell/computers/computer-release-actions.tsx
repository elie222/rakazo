import { Trans } from "@lingui/react/macro";
import type { ComputerReleaseReason } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useRef, useState } from "react";

export function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  const [releasing, setReleasing] = useState(false);
  const releasingRef = useRef(false);

  const release = async (reason?: ComputerReleaseReason) => {
    if (releasingRef.current) return;
    releasingRef.current = true;
    setReleasing(true);
    try {
      await onRelease(reason);
    } finally {
      releasingRef.current = false;
      setReleasing(false);
    }
  };

  if (!takeoverRequested) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={releasing}
        onClick={() => void release()}
      >
        <Trans>Hand back control</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={releasing}
        onClick={() => void release("skipped")}
      >
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" disabled={releasing} onClick={() => void release("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}
