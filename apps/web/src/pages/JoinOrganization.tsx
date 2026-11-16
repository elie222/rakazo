import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { OrganizationInvitationPreview } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { AuthFrame, submitClass } from "./Auth";

// The invitation names its own organization, so a remembered Space that is no longer available
// must not send the request through space recovery and away from it.
const NO_SPACE = { context: { spaceId: null } };

type JoinState =
  | { kind: "loading" }
  | { kind: "ready"; preview: OrganizationInvitationPreview }
  | { kind: "refused"; message: string | null }
  | { kind: "error"; message: string };

/** The server refusing: used, expired or unknown (no message), or another address's invitation. */
function refusal(error: unknown): { message: string | null } | null {
  if (!(error instanceof ORPCError) || error.status < 400 || error.status >= 500) return null;
  return { message: error.status === 403 ? errorText(error) : null };
}

export function JoinOrganizationPage() {
  const { invitationId = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<JoinState>({ kind: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    rpc.organizations.invitations
      .preview({ invitationId }, NO_SPACE)
      .then((preview) => {
        if (active) setState({ kind: "ready", preview });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const refused = refusal(err);
        setState(
          refused ? { kind: "refused", ...refused } : { kind: "error", message: errorText(err) },
        );
      });
    return () => {
      active = false;
    };
  }, [invitationId, attempt]);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const { spaceId } = await rpc.organizations.invitations.accept({ invitationId }, NO_SPACE);
      selectSpace(spaceId);
      navigate("/app", { replace: true });
    } catch (err) {
      const refused = refusal(err);
      if (refused) setState({ kind: "refused", ...refused });
      else setJoinError(errorText(err));
      setJoining(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="grid h-full place-items-center text-muted-foreground/80">
        <Trans>Loading…</Trans>
      </div>
    );
  }

  if (state.kind === "refused" || state.kind === "error") {
    return (
      <AuthFrame
        title={
          state.kind === "error"
            ? state.message
            : (state.message ?? <Trans>This invitation is no longer valid.</Trans>)
        }
        onSubmit={(event) => {
          event.preventDefault();
          if (state.kind === "error") setAttempt((value) => value + 1);
          else navigate("/app", { replace: true });
        }}
      >
        <Button type="submit" className={submitClass}>
          {state.kind === "error" ? <Trans>Retry</Trans> : <Trans>Open Rakazo</Trans>}
        </Button>
      </AuthFrame>
    );
  }

  const { organizationName, inviterName } = state.preview;
  return (
    <AuthFrame title={<Trans>Join {organizationName}</Trans>} onSubmit={join}>
      <p className="-mt-6 text-center text-muted-foreground">
        <Trans>{inviterName} invited you</Trans>
      </p>
      {joinError ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {joinError}
        </p>
      ) : null}
      <Button type="submit" disabled={joining} className={cn(submitClass, "mt-6")}>
        <Trans>Join</Trans>
      </Button>
    </AuthFrame>
  );
}
