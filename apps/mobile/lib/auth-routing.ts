export type AuthMode = "in" | "up" | "forgot";

export const explicitSignInRoute = {
  pathname: "/sign-in",
  params: { mode: "in" },
} as const;

export function initialAuthMode(requestedMode?: string | string[]): AuthMode {
  return requestedMode === "in" ? "in" : "up";
}
