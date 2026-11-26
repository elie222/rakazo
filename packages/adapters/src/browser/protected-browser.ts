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
type BrowserStep = { name: string } & (
  | { kind: "click"; role: BrowserControlRole }
  | { kind: "fill"; role: BrowserControlRole; text: string }
  | { kind: "wait"; role: BrowserControlRole | "heading" }
);

/** For asynchronous sign-in, wait for a site-specific success control before capturing storage. */
export type ProtectedBrowserRequest = {
  url: string;
  steps: BrowserStep[];
} & ({ mode: "sign-in" } | { mode: "browse"; storageState: ProtectedBrowserStorage });

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
