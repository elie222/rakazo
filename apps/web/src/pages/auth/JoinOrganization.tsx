import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { OrganizationInvitationPreview } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSave } from "../../lib/query/query";
import { clearSpaceSelection, rpc, selectSpace } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
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
  // Only "not found" means the invitation is gone; any other refusal says why in its own words.
  return { message: error.status === 404 ? null : errorText(error) };
}

export function JoinOrganizationPage() {
  const { invitationId = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<JoinState>({ kind: "loading" });
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

  const join = useSave({
    save: (id: string, client) =>
      client.organizations.invitations.accept({ invitationId: id }, NO_SPACE),
    closesScreen: true,
    onSaved: ({ spaceId }) => {
      if (!selectSpace(spaceId)) clearSpaceSelection();
      navigate("/app", { replace: true });
    },
    onFailed: (error) => {
      const refused = refusal(error);
      if (refused) setState({ kind: "refused", ...refused });
    },
  });
  const joinError = join.error && !refusal(join.error) ? errorText(join.error) : null;

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
    <AuthFrame
      title={<Trans>Join {organizationName}</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        join.run(invitationId);
      }}
    >
      <p className="-mt-6 text-center text-muted-foreground">
        <Trans>{inviterName} invited you</Trans>
      </p>
      {joinError ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {joinError}
        </p>
      ) : null}
      <Button type="submit" disabled={join.pending} className={cn(submitClass, "mt-6")}>
        <Trans>Join</Trans>
      </Button>
    </AuthFrame>
  );
}
