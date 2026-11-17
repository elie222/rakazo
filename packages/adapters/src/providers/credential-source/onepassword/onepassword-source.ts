import type { CredentialSource, CredentialSourceItem } from "@rakazo/adapter-kit";
import {
  CredentialSourceItemGoneError,
  CredentialSourceRefusedError,
  CredentialSourceUnavailableError,
} from "@rakazo/adapter-kit";
import type { ProviderSettingsField } from "@rakazo/contracts";
import { DEFAULT_LOGIN_FIELD_LABELS, LoginSecretValue, trimEndChars } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import * as z from "zod";
import { isEgressRefused } from "../../../network-address.js";
import type { SafeWebFetchOptions } from "../../../web-ssrf.js";
import { fetchSafeHttpRequest } from "../../../web-ssrf.js";

export const ONEPASSWORD_SOURCE_ID = "onepassword";

/** A vault's item list can be long; each single answer stays bounded (a listing is bounded by time). */
const MAX_ANSWER_BYTES = 5_000_000;

/** Listing asks once per vault, so it has a time limit of its own on top of each request's. */
const LIST_BUDGET_MS = 60_000;

/** What the settings form asks for. Public metadata only, like every provider's. */
export const onePasswordSourceSettings: {
  displayName: string;
  fields: ProviderSettingsField[];
  connectionLabel(settings: Record<string, string>): string;
} = {
  displayName: "1Password",
  fields: [
    {
      key: "endpoint",
      label: "Connect server address",
      kind: "url",
      required: true,
      validation: "public-https",
      // The token is sent to this address, so a saved one must be entered again when it changes.
      scopesSecrets: true,
      placeholder: "https://connect.example.com",
      description: "The address of your 1Password Connect server. It must be reachable over HTTPS.",
    },
    {
      key: "token",
      label: "Access token",
      kind: "secret",
      required: true,
      description: "A Connect token that can read the vaults you want to link logins from.",
    },
  ],
  connectionLabel: (settings) => URL.parse(settings.endpoint ?? "")?.host ?? "",
};

/** The Connect server's address without a trailing slash; it may sit under a path. */
export function normalizeOnePasswordEndpoint(endpoint: string): string {
  const url = URL.parse(endpoint.trim());
  if (url?.protocol !== "https:") throw new Error("endpoint must be an https address");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint must be a plain address");
  }
  return `${url.origin}${trimEndChars(url.pathname, "/")}`;
}

// Connect names every vault and item with 26 lowercase letters and digits. Anything else is
// refused before it can reach a path.
const ConnectId = z.string().regex(/^[a-z0-9]{26}$/);
const Vaults = z.array(z.object({ id: ConnectId }));
const Items = z.array(
  z.object({
    id: ConnectId,
    title: z.string(),
    category: z.string(),
    urls: z.array(z.object({ href: z.string(), primary: z.boolean().optional() })).optional(),
  }),
);
const Item = z.object({
  category: z.string(),
  fields: z.array(z.object({ purpose: z.string().optional(), value: z.string().optional() })),
});

function isWebAddress(address: string): boolean {
  const protocol = URL.parse(address)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

export type OnePasswordSourceDeps = Pick<SafeWebFetchOptions, "fetch" | "resolveHostname"> & {
  /** How long a whole listing may take; tests shorten it. */
  listBudgetMs?: number;
};

export function createOnePasswordSource(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  deps: OnePasswordSourceDeps = {},
): CredentialSource {
  const base = normalizeOnePasswordEndpoint(settings.endpoint ?? "");
  const token = credentials.token?.trim();
  if (!token) throw new Error("token is required");

  /** The answer's JSON, or the error this adapter's callers handle. */
  async function get(path: string, signal: AbortSignal, notFound?: Error): Promise<unknown> {
    let response: Awaited<ReturnType<typeof fetchSafeHttpRequest>>;
    try {
      response = await fetchSafeHttpRequest(
        `${base}${path}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        },
        { ...deps, signal, maxBytes: MAX_ANSWER_BYTES },
      );
    } catch (error) {
      signal.throwIfAborted();
      // A destination the egress guard refused is the caller's to report, not a source outage.
      if (isEgressRefused(error)) throw error;
      // The transport error is not kept as a cause: it may quote the request, token included.
      throw new CredentialSourceUnavailableError("The credential source could not be reached");
    }
    if (response.status === 401 || response.status === 403) {
      throw new CredentialSourceRefusedError();
    }
    if (response.status === 404 && notFound) throw notFound;
    if (response.status !== 200 || response.truncated) {
      throw new CredentialSourceUnavailableError(
        `The credential source answered ${response.status}`,
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      // A parse error quotes part of the body, which may hold a login's values.
      return unusable();
    }
  }

  function unusable(): never {
    throw new CredentialSourceUnavailableError("The credential source gave an unusable answer");
  }

  return {
    describe: () => ({
      id: ONEPASSWORD_SOURCE_ID,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { readOnly: true },
    }),

    async listItems(callerSignal) {
      // One request per vault: the whole listing shares a budget, not a fresh timeout per vault.
      const signal = deadlineSignal(deps.listBudgetMs ?? LIST_BUDGET_MS, callerSignal);
      try {
        const vaults = Vaults.safeParse(await get("/v1/vaults", signal));
        if (!vaults.success) return unusable();
        const listed: CredentialSourceItem[] = [];
        for (const vault of vaults.data) {
          const items = Items.safeParse(await get(`/v1/vaults/${vault.id}/items`, signal));
          if (!items.success) return unusable();
          for (const item of items.data) {
            if (item.category !== "LOGIN") continue;
            const site = (item.urls?.find((url) => url.primary) ?? item.urls?.[0])?.href;
            listed.push({
              ref: `${vault.id}/${item.id}`,
              title: item.title,
              ...(site && isWebAddress(site) ? { url: site } : {}),
            });
          }
        }
        return listed;
      } catch (error) {
        // Only the abort itself is reclassified; a refusal or a bad answer that lands as the budget
        // runs out keeps its own kind. The caller's abort wins when both have fired.
        if (error !== signal.reason) throw error;
        if (callerSignal.aborted) throw callerSignal.reason;
        throw new CredentialSourceUnavailableError("The credential source took too long to list");
      }
    },

    async resolve(ref, signal): Promise<LoginSecretValue> {
      const gone = new CredentialSourceItemGoneError();
      const [vaultId, itemId, ...rest] = ref.split("/");
      if (
        !ConnectId.safeParse(vaultId).success ||
        !ConnectId.safeParse(itemId).success ||
        rest.length
      ) {
        throw gone;
      }
      const answer = Item.safeParse(
        await get(`/v1/vaults/${vaultId}/items/${itemId}`, signal, gone),
      );
      if (!answer.success) return unusable();
      if (answer.data.category !== "LOGIN") throw gone;
      const fieldValue = (purpose: string) =>
        answer.data.fields.find((field) => field.purpose === purpose)?.value ?? "";
      const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
      const username = fieldValue("USERNAME").trim();
      const password = fieldValue("PASSWORD");
      if (!password) throw gone;
      const login = LoginSecretValue.safeParse({
        fields: [
          ...(username ? [{ label: usernameLabel, value: username, hidden: false }] : []),
          { label: passwordLabel, value: password, hidden: true },
        ],
      });
      if (!login.success) throw gone;
      return login.data;
    },
  };
}
