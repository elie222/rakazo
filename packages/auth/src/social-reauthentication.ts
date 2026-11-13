import type { BetterAuthPlugin } from "better-auth";
import { getOAuthState } from "better-auth/api";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { IDENTITY_CONFIRMATION_MS } from "./identity-confirmation.js";

/** Guard the verified provider identity before Better Auth can create or link accounts. */
export function socialReauthentication(): BetterAuthPlugin {
  return {
    id: "social-reauthentication",
    init(ctx) {
      return {
        context: {
          socialProviders: ctx.socialProviders.map((provider) => {
            if (provider.id !== "google" && provider.id !== "apple") return provider;
            return {
              ...provider,
              requiresIdTokenNonce: true,
              createAuthorizationURL: async (data) => {
                const url = await provider.createAuthorizationURL(data);
                if (data.idTokenNonce) url.searchParams.set("nonce", data.idTokenNonce);
                const context = (await getOAuthState())?.serverContext;
                if (typeof context?.reauthUserId === "string") {
                  // Google supports an explicit account chooser; Apple always presents its
                  // authorization UI. Neither supports OIDC's max_age/auth_time contract.
                  if (provider.id === "google") url.searchParams.set("prompt", "select_account");
                }
                if (data.idTokenNonce) {
                  await ctx.internalAdapter.createVerificationValue({
                    identifier: `identity-callback-${data.state}`,
                    value: `${provider.id}:${data.idTokenNonce}`,
                    expiresAt: new Date(Date.now() + IDENTITY_CONFIRMATION_MS),
                  });
                }
                return url;
              },
              validateAuthorizationCode: async (data) => {
                const state = await getOAuthState();
                // Claim before exchange so parallel callbacks cannot both authorize a session.
                if (!state) return null;
                {
                  const marker = await ctx.internalAdapter.consumeVerificationValue(
                    `identity-callback-${state.oauthState}`,
                  );
                  if (
                    !marker ||
                    marker.expiresAt.getTime() <= Date.now() ||
                    marker.value !== `${provider.id}:${state.idTokenNonce}`
                  )
                    return null;
                }
                return provider.validateAuthorizationCode(data);
              },
              getUserInfo: async (tokens) => {
                const context = (await getOAuthState())?.serverContext;
                if (
                  typeof context?.reauthUserId === "string" &&
                  (!tokens.idToken ||
                    !tokens.expectedIdTokenNonce ||
                    !(await verifyProviderIdToken(
                      provider,
                      tokens.idToken,
                      tokens.expectedIdTokenNonce,
                    )))
                )
                  return null;
                const info = await provider.getUserInfo(tokens);
                if (typeof context?.reauthUserId !== "string") return info;
                const subject = info?.data && "sub" in info.data ? info.data.sub : undefined;
                if (typeof subject !== "string" || !subject) return null;
                const account = await ctx.internalAdapter.findAccountByKey({
                  providerId: provider.id,
                  accountId: subject,
                });
                const session =
                  typeof context.reauthSessionToken === "string"
                    ? await ctx.internalAdapter.findSession(context.reauthSessionToken)
                    : null;
                const startedAt = context.reauthStartedAt;
                if (
                  context.reauthProviderId !== provider.id ||
                  !Array.isArray(context.reauthAccountIds) ||
                  !context.reauthAccountIds.includes(subject) ||
                  account?.userId !== context.reauthUserId ||
                  session?.user.id !== context.reauthUserId ||
                  session.session.expiresAt.getTime() <= Date.now() ||
                  typeof startedAt !== "number" ||
                  !Number.isSafeInteger(startedAt) ||
                  startedAt * 1000 > Date.now() ||
                  startedAt * 1000 + IDENTITY_CONFIRMATION_MS <= Date.now()
                )
                  return null;
                context.reauthExpiresAt = startedAt * 1000 + IDENTITY_CONFIRMATION_MS;
                return info;
              },
            };
          }),
        },
      };
    },
  };
}
