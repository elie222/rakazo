const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{1,200}$/;

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (next === "/integrations/setup") return next;
  if (next && INVITE_PATH.test(next)) return next;
  return null;
}
