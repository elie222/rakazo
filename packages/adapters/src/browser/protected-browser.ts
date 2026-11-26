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
