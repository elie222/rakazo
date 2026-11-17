import type { CredentialSource, CredentialSourceItem } from "@rakazo/adapter-kit";
import {
  CredentialSourceItemGoneError,
  CredentialSourceRefusedError,
  CredentialSourceUnavailableError,
} from "@rakazo/adapter-kit";
import type { ProviderSettingsField } from "@rakazo/contracts";
import { DEFAULT_LOGIN_FIELD_LABELS, LoginSecretValue } from "@rakazo/contracts";
import * as z from "zod";
import { isEgressRefused } from "../../../network-address.js";
import type { SafeWebFetchOptions } from "../../../web-ssrf.js";
import { fetchSafeHttpRequest } from "../../../web-ssrf.js";

export const ONEPASSWORD_SOURCE_ID = "onepassword";

/** A Connect server lists every item of every vault its token can read; the answer stays bounded. */
const MAX_ANSWER_BYTES = 5_000_000;

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
      destination: "token",
      placeholder: "https://connect.example.com",
      description: "The address of your 1Password Connect server. It must be reachable over HTTPS.",
    },
    {
      key: "token",
      label: "Access token",
      kind: "secret",
      required: true,
      scopesSecrets: true,
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
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
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

export type OnePasswordSourceDeps = Pick<SafeWebFetchOptions, "fetch" | "resolveHostname">;

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
      throw new CredentialSourceUnavailableError("The credential source could not be reached", {
        cause: error,
      });
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
    } catch (error) {
      throw new CredentialSourceUnavailableError("The credential source gave an unusable answer", {
        cause: error,
      });
    }
  }

  function unusable(error: unknown): never {
    throw new CredentialSourceUnavailableError("The credential source gave an unusable answer", {
      cause: error,
    });
  }

  return {
    describe: () => ({
      id: ONEPASSWORD_SOURCE_ID,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { readOnly: true },
    }),

    async listItems(signal) {
      const vaults = Vaults.safeParse(await get("/v1/vaults", signal));
      if (!vaults.success) return unusable(vaults.error);
      const listed: CredentialSourceItem[] = [];
      for (const vault of vaults.data) {
        const items = Items.safeParse(await get(`/v1/vaults/${vault.id}/items`, signal));
        if (!items.success) return unusable(items.error);
        for (const item of items.data) {
          if (item.category !== "LOGIN") continue;
          const site = (item.urls?.find((url) => url.primary) ?? item.urls?.[0])?.href;
          listed.push({
            ref: `${vault.id}/${item.id}`,
            title: item.title,
            ...(site && URL.canParse(site) ? { url: site } : {}),
          });
        }
      }
      return listed;
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
      if (!answer.success) return unusable(answer.error);
      if (answer.data.category !== "LOGIN") throw gone;
      const fieldValue = (purpose: string) =>
        answer.data.fields.find((field) => field.purpose === purpose)?.value ?? "";
      const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
      const username = fieldValue("USERNAME");
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
