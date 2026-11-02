let displayedUserId: string | null = null;
let paused = false;

/** The identity rendered by this page, never the cookie selected by another tab. */
export function setAccountIdentity(userId: string | null): void {
  // A confirmed change reloads the page. Retain the old guard until that reload lands.
  if (displayedUserId === null || userId === null) displayedUserId = userId;
  if (userId === null) paused = false;
}

export function accountIdentity(): string | null {
  return displayedUserId;
}

export function pauseAccountRequests(): void {
  paused = true;
}

export function accountRequestHeaders(init?: HeadersInit): Headers {
  if (paused) throw new Error("Account changed");
  const headers = new Headers(init);
  if (displayedUserId) headers.set("x-rakazo-user-id", displayedUserId);
  return headers;
}
