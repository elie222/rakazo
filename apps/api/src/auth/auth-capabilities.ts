import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { Auth } from "@rakazo/auth";
import { publicSignInProviders } from "@rakazo/auth";
import type { AuthCapabilities } from "@rakazo/contracts";
import { signupsOpen } from "@rakazo/core";
import type { Hono } from "hono";
import type { BillingService } from "../billing/billing.js";
import type { AppEnv } from "../env.js";
import { nativePasskeys } from "../http/app-association.js";

/** `GET /api/auth/capabilities`: the sign-in options this deployment offers. */
export function mountAuthCapabilities(
  app: Hono,
  {
    env,
    auth,
    email,
    billing,
  }: {
    env: AppEnv;
    auth: Auth;
    email: TransactionalEmailProvider | undefined;
    billing: BillingService | undefined;
  },
) {
  app.get("/api/auth/capabilities", (c) => {
    // The app-managed local stack admits one account per-request; other deployments close
    // registration from their signup policy environment, which clients also hide behind.
    const registrationOpen = env.desktopStackToken
      ? auth.registrationOpen(c.req.raw.headers)
      : signupsOpen(env.signupsEnabled);
    return c.json({
      sso: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : null,
      providers: publicSignInProviders(env.social, env.oidc),
      passwordAuth: env.passwordAuth !== false,
      passwordReset: env.passwordAuth !== false && Boolean(email),
      resetUrl:
        env.passwordAuth !== false && email ? new URL("/reset-password", env.webOrigin).href : null,
      emailCode: auth.emailCodeSignIn,
      registrationOpen,
      billing: Boolean(billing),
      passkeyRpId: auth.passkeyRpId,
      nativePasskeys: nativePasskeys(env, auth.passkeyRpId),
      crispWebsiteId: billing ? (env.crispWebsiteId ?? null) : null,
      demoAccount: env.demoAccount ?? null,
    } satisfies AuthCapabilities);
  });
}
