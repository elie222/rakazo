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

type BrowserStep = {
  role: "button" | "checkbox" | "combobox" | "link" | "radio" | "textbox";
  name: string;
} & ({ kind: "click" } | { kind: "fill"; text: string });

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
