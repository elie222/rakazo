export interface ProtectedBrowserStorage {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    partitionKey?: string;
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

type BrowserControlRole = "button" | "checkbox" | "combobox" | "link" | "radio" | "textbox";
type BrowserWait = { kind: "wait"; role: BrowserControlRole | "heading"; name: string };
type BrowserStep = { name: string } & (
  | { kind: "click"; role: BrowserControlRole }
  | { kind: "fill"; role: BrowserControlRole; text: string }
);

/** End sign-in with a condition that becomes visible only after authentication. */
export type ProtectedBrowserRequest = {
  url: string;
} & (
  | { mode: "sign-in"; steps: [...(BrowserStep | BrowserWait)[], BrowserWait] }
  | { mode: "browse"; steps: (BrowserStep | BrowserWait)[]; storageState: ProtectedBrowserStorage }
);

export interface ProtectedBrowserResult {
  storageState: ProtectedBrowserStorage;
  page?: string;
}

export type ProtectedBrowserLauncher = (
  request: ProtectedBrowserRequest,
  signal?: AbortSignal,
) => Promise<ProtectedBrowserResult>;

export class ProtectedBrowserError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "timeout"
      | "sign-in-rejected"
      | "invalid-output"
      | "container-exit",
  ) {
    super("The protected browser operation failed.");
  }
}
