import {
  CredentialSourceItemGoneError,
  CredentialSourceRefusedError,
  CredentialSourceUnavailableError,
} from "@rakazo/adapter-kit";
import { ProviderSettingsFieldSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { isEgressRefused } from "../../../network-address.js";
import {
  createOnePasswordSource,
  normalizeOnePasswordEndpoint,
  ONEPASSWORD_SOURCE_ID,
  onePasswordSourceSettings,
} from "./onepassword-source.js";

const VAULT = "a".repeat(26);
const OTHER_VAULT = "b".repeat(26);
const ITEM = "c".repeat(26);
const TOKEN = "connect-token-value";
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

type Answer = Response | Error;

function setup(answers: Record<string, Answer>, endpoint = "https://connect.example.com") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const answer = answers[url.pathname];
    if (!answer) return new Response("not found", { status: 404 });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  const source = createOnePasswordSource(
    { endpoint },
    { token: TOKEN },
    { fetch, resolveHostname: publicResolver },
  );
  return { source, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;

describe("1Password credential source", () => {
  it("lists only logins, with the site each names and no values", async () => {
    const { source, fetch } = setup({
      "/v1/vaults": json([{ id: VAULT }, { id: OTHER_VAULT }]),
      [`/v1/vaults/${VAULT}/items`]: json([
        {
          id: ITEM,
          title: "Bank",
          category: "LOGIN",
          urls: [
            { href: "https://old.example.com" },
            { href: "https://bank.example.com/login", primary: true },
          ],
        },
        { id: "d".repeat(26), title: "Card", category: "CREDIT_CARD" },
      ]),
      [`/v1/vaults/${OTHER_VAULT}/items`]: json([
        { id: "e".repeat(26), title: "Forum", category: "LOGIN", urls: [{ href: "not a url" }] },
      ]),
    });
    expect(await source.listItems(signal())).toEqual([
      { ref: `${VAULT}/${ITEM}`, title: "Bank", url: "https://bank.example.com/login" },
      { ref: `${OTHER_VAULT}/${"e".repeat(26)}`, title: "Forum" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `https://connect.example.com/v1/vaults/${VAULT}/items`,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  it("reads the login an item holds now", async () => {
    const { source } = setup({
      [`/v1/vaults/${VAULT}/items/${ITEM}`]: json({
        category: "LOGIN",
        fields: [
          { purpose: "USERNAME", value: "ada" },
          { purpose: "PASSWORD", value: "s3cret" },
          { purpose: "NOTES", value: "ignored" },
        ],
      }),
    });
    expect(await source.resolve(`${VAULT}/${ITEM}`, signal())).toEqual({
      fields: [
        { label: "Username", value: "ada", hidden: false },
        { label: "Password", value: "s3cret", hidden: true },
      ],
    });
  });

  it("reads a login whose username is blank as a password-only login", async () => {
    const { source } = setup({
      [`/v1/vaults/${VAULT}/items/${ITEM}`]: json({
        category: "LOGIN",
        fields: [
          { purpose: "USERNAME", value: "   " },
          { purpose: "PASSWORD", value: "s3cret" },
        ],
      }),
    });
    expect(await source.resolve(`${VAULT}/${ITEM}`, signal())).toEqual({
      fields: [{ label: "Password", value: "s3cret", hidden: true }],
    });
  });

  it("names a site only when it is a web address", async () => {
    const { source } = setup({
      "/v1/vaults": json([{ id: VAULT }]),
      [`/v1/vaults/${VAULT}/items`]: json([
        { id: ITEM, title: "Script", category: "LOGIN", urls: [{ href: "javascript:alert(1)" }] },
        {
          id: "d".repeat(26),
          title: "Plain",
          category: "LOGIN",
          urls: [{ href: "http://plain.example.com" }],
        },
      ]),
    });
    expect(await source.listItems(signal())).toEqual([
      { ref: `${VAULT}/${ITEM}`, title: "Script" },
      { ref: `${VAULT}/${"d".repeat(26)}`, title: "Plain", url: "http://plain.example.com" },
    ]);
  });

  it("reads a login that has only a password", async () => {
    const { source } = setup({
      [`/v1/vaults/${VAULT}/items/${ITEM}`]: json({
        category: "LOGIN",
        fields: [{ purpose: "PASSWORD", value: "s3cret" }],
      }),
    });
    expect(await source.resolve(`${VAULT}/${ITEM}`, signal())).toEqual({
      fields: [{ label: "Password", value: "s3cret", hidden: true }],
    });
  });

  it("says an item is gone when it is missing, not a login, or has no password", async () => {
    const { source } = setup({
      [`/v1/vaults/${VAULT}/items/${ITEM}`]: json({
        category: "LOGIN",
        fields: [{ purpose: "USERNAME", value: "ada" }],
      }),
      [`/v1/vaults/${VAULT}/items/${"d".repeat(26)}`]: json({
        category: "SECURE_NOTE",
        fields: [],
      }),
    });
    await expect(source.resolve(`${VAULT}/${ITEM}`, signal())).rejects.toBeInstanceOf(
      CredentialSourceItemGoneError,
    );
    await expect(source.resolve(`${VAULT}/${"d".repeat(26)}`, signal())).rejects.toBeInstanceOf(
      CredentialSourceItemGoneError,
    );
    await expect(source.resolve(`${VAULT}/${"f".repeat(26)}`, signal())).rejects.toBeInstanceOf(
      CredentialSourceItemGoneError,
    );
  });

  it("never lets a malformed address reach a path", async () => {
    const { source, fetch } = setup({});
    for (const ref of ["", "nope", `${VAULT}/../${ITEM}`, `${VAULT}/${ITEM}/extra`, `${VAULT}/x`]) {
      await expect(source.resolve(ref, signal())).rejects.toBeInstanceOf(
        CredentialSourceItemGoneError,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a vault id the server sends that is not an id", async () => {
    const { source, fetch } = setup({ "/v1/vaults": json([{ id: "../../admin" }]) });
    await expect(source.listItems(signal())).rejects.toBeInstanceOf(
      CredentialSourceUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tells a refused token from an outage", async () => {
    for (const status of [401, 403]) {
      const { source } = setup({ "/v1/vaults": json({}, status) });
      await expect(source.listItems(signal())).rejects.toBeInstanceOf(CredentialSourceRefusedError);
    }
    for (const status of [429, 500, 503]) {
      const { source } = setup({ "/v1/vaults": json({}, status) });
      await expect(source.listItems(signal())).rejects.toBeInstanceOf(
        CredentialSourceUnavailableError,
      );
    }
    const { source } = setup({ "/v1/vaults": new Error("socket hang up") });
    await expect(source.listItems(signal())).rejects.toBeInstanceOf(
      CredentialSourceUnavailableError,
    );
  });

  it("answers an unusable body as an outage, never an empty list", async () => {
    for (const body of [new Response("<html>"), json({ vaults: [] }), json([{ id: 5 }])]) {
      const { source } = setup({ "/v1/vaults": body });
      await expect(source.listItems(signal())).rejects.toBeInstanceOf(
        CredentialSourceUnavailableError,
      );
    }
  });

  it("does not follow a redirect with the token", async () => {
    const { source, fetch } = setup({
      "/v1/vaults": new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example.net/v1/vaults" },
      }),
    });
    await expect(source.listItems(signal())).rejects.toBeInstanceOf(
      CredentialSourceUnavailableError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the token out of every error, its cause included", async () => {
    const secretBody = new Response(`{"password": "${TOKEN}"`);
    const answers = [
      new Error(`failed with ${TOKEN}`),
      secretBody,
      json([{ id: TOKEN }]),
      json({}, 500),
    ];
    for (const answer of answers) {
      const { source } = setup({ "/v1/vaults": answer });
      const error = await source.listItems(signal()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CredentialSourceUnavailableError);
      expect((error as Error).cause).toBeUndefined();
      expect(
        JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).stack),
      ).not.toContain(TOKEN);
    }
  });

  it("passes a refused private destination through without asking it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const source = createOnePasswordSource(
      { endpoint: "https://connect.internal.example.com" },
      { token: TOKEN },
      { fetch, resolveHostname: async () => [{ address: "10.0.0.5", family: 4 }] },
    );
    const error = await source.listItems(signal()).catch((caught: unknown) => caught);
    expect(isEgressRefused(error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops with the caller's own abort", async () => {
    const { source } = setup({ "/v1/vaults": json([]) });
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    await expect(source.listItems(controller.signal)).rejects.toThrow("caller gave up");
  });

  it("works under a path on the server's address", async () => {
    const { source, fetch } = setup(
      { "/connect/v1/vaults": json([]) },
      "https://example.com/connect/",
    );
    expect(await source.listItems(signal())).toEqual([]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.com/connect/v1/vaults");
  });

  it("describes itself as read-only", () => {
    const { source } = setup({});
    expect(source.describe()).toEqual({
      id: ONEPASSWORD_SOURCE_ID,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { readOnly: true },
    });
  });
});

describe("1Password connection settings", () => {
  it("asks for a form the settings screen can draw", () => {
    for (const field of onePasswordSourceSettings.fields) {
      expect(ProviderSettingsFieldSchema.safeParse(field).success).toBe(true);
    }
    expect(
      onePasswordSourceSettings.connectionLabel({ endpoint: "https://connect.example.com/x" }),
    ).toBe("connect.example.com");
    expect(onePasswordSourceSettings.connectionLabel({})).toBe("");
  });

  it("makes a saved token follow the server it is sent to", () => {
    const scoping = onePasswordSourceSettings.fields.filter((field) => field.scopesSecrets);
    expect(scoping.map((field) => field.key)).toEqual(["endpoint"]);
    expect(onePasswordSourceSettings.fields.some((field) => field.destination)).toBe(false);
  });

  it("accepts a plain https address and trims it", () => {
    expect(normalizeOnePasswordEndpoint(" https://connect.example.com:8443/ ")).toBe(
      "https://connect.example.com:8443",
    );
  });

  it.each([
    "http://connect.example.com",
    "https://user:pass@connect.example.com",
    "https://connect.example.com?x=1",
    "https://connect.example.com#frag",
    "connect.example.com",
    "",
  ])("refuses %j as an address", (endpoint) => {
    expect(() => normalizeOnePasswordEndpoint(endpoint)).toThrow();
  });

  it("needs a token", () => {
    expect(() =>
      createOnePasswordSource({ endpoint: "https://connect.example.com" }, { token: " " }),
    ).toThrow("token is required");
  });
});
