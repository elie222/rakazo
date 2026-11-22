import { AnalyticsSurface } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PiOAuthEnd, PiOAuthPending } from "./pi-oauth-ended.js";

type SignInLogContext = Pick<PiOAuthPending, "provider" | "startedAt" | "measure"> & {
  id: string;
  mode?: PiOAuthPending["mode"];
};

type SignInStage =
  | "started"
  | "authorization_ready"
  | "code_submitted"
  | "authorized"
  | "saving"
  | "connected"
  | "ended"
  | "resumed"
  | "replaced"
  | "interrupted"
  | "handoff_lost"
  | "handoff_unreadable"
  | "start_failed"
  | "storage_failed";

/** One trace across requests and processes; never codes, credentials, URLs or error text. */
export function logModelSignIn(
  signIn: SignInLogContext,
  stage: SignInStage,
  end?: PiOAuthEnd,
): void {
  const surface = AnalyticsSurface.safeParse(signIn.measure?.surface);
  getLogger().info("model sign-in lifecycle", {
    "model.sign_in.id": signIn.id,
    "model.sign_in.stage": stage,
    "model.sign_in.provider": signIn.provider,
    "model.sign_in.flow": signIn.mode,
    "model.sign_in.elapsed_ms": Math.max(0, Date.now() - signIn.startedAt.getTime()),
    "model.sign_in.surface": surface.success ? surface.data : undefined,
    "model.sign_in.attempt": signIn.measure?.attempt,
    "model.sign_in.reason": end?.reason,
    "model.sign_in.error_class": end?.errorClass,
  });
}
