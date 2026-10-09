import { router } from "expo-router";

export type AuthMode = "in" | "up" | "forgot";

export const explicitSignInRoute = {
  pathname: "/sign-in",
  params: { mode: "in" },
} as const;

export function initialAuthMode(requestedMode?: string | string[]): AuthMode {
  return requestedMode === "in" ? "in" : "up";
}

/** Leaves every screen, including the settings sheet at any depth, for sign-in alone.
 * `dismissAll` would only pop the stack in front, so a pushed settings page kept the sheet open. */
export function replaceWithSignIn(
  route: typeof explicitSignInRoute | "/sign-in" = explicitSignInRoute,
) {
  router.dismissTo("/");
  router.replace(route);
}
