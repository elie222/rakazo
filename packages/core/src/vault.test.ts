import type { BotSecretMetadata } from "@rakazo/contracts";
import { BLOCKED_ITEM_ANSWER, encodeLoginSecret, UNCHOSEN_ITEM_ANSWER } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { secretAnswerRefusal, vaultImportProblemList, vaultSaveDrops } from "./vault.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
const fields = [{ label: "Password", value: "saved-password-1", hidden: true }];
const withKey = encodeLoginSecret({ fields, otp: TEST_KEY });

describe("secretAnswerRefusal", () => {
  it("names only the server's two fixed refusals", () => {
    expect(secretAnswerRefusal(new Error(BLOCKED_ITEM_ANSWER))).toBe("blocked");
    expect(secretAnswerRefusal({ message: UNCHOSEN_ITEM_ANSWER })).toBe("unchosen");
    for (const error of [
      new Error(`${BLOCKED_ITEM_ANSWER} saved-password-1`),
      new Error("Could not save saved-password-1"),
      BLOCKED_ITEM_ANSWER,
      { message: 3 },
      null,
      undefined,
    ])
      expect(secretAnswerRefusal(error)).toBeUndefined();
  });
});

describe("vaultSaveDrops", () => {
  const login = (fields: Partial<BotSecretMetadata> = {}) =>
    ({ preview: { username: "octo" }, ...fields }) as BotSecretMetadata;

  it("names what a server that doesn't know it dropped", () => {
    expect(vaultSaveDrops({ policy: "ask" }, login({ policy: "allow" }))).toEqual(["ask"]);
    expect(vaultSaveDrops({ policy: "off" }, login())).toEqual(["block"]);
    expect(vaultSaveDrops({ allBots: false }, login())).toEqual(["bots"]);
  });

  // Every combination sent to a server that knows none of it: each drop is named on its own, and
  // Allow, what such a server does anyway, is never one.
  const policies = [undefined, "allow", "ask", "off"] as const;
  const flags = [false, true];
  const combinations = policies.flatMap((policy) =>
    flags.flatMap((bots) =>
      flags.flatMap((alsoOn) => flags.map((key) => ({ policy, bots, alsoOn, key }))),
    ),
  );
  it.each(combinations)(
    "names each drop on its own: policy $policy, bots $bots, other sites $alsoOn, key $key",
    ({ policy, bots, alsoOn, key }) => {
      const sent = {
        ...(policy ? { policy } : {}),
        ...(bots ? { allBots: false } : {}),
        ...(alsoOn ? { alsoOn: ["https://www.example.test"] } : {}),
        value: key ? withKey : encodeLoginSecret({ fields }),
      };
      const expected = [
        ...(policy === "ask" ? ["ask"] : policy === "off" ? ["block"] : []),
        ...(bots ? ["bots"] : []),
        ...(alsoOn ? ["alsoOn"] : []),
        ...(key ? ["authenticatorKey"] : []),
      ];
      expect(vaultSaveDrops(sent, login())).toEqual(expected);
    },
  );

  it("names nothing a server kept, and no key when the preview couldn't be read", () => {
    expect(
      vaultSaveDrops(
        { policy: "ask", allBots: false, alsoOn: ["https://www.example.test"], value: withKey },
        login({
          policy: "ask",
          allBots: false,
          alsoOn: ["https://www.example.test"],
          preview: { username: "octo", otp: true },
        }),
      ),
    ).toEqual([]);
    expect(vaultSaveDrops({ value: withKey }, login({ preview: undefined }))).toEqual([]);
    expect(vaultSaveDrops({ value: encodeLoginSecret({ fields }) }, login())).toEqual([]);
  });
});

describe("vaultImportProblemList", () => {
  const problems = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      line: index + 1,
      label: `site-${index + 1}.example.test`,
      reason: "notHttps" as const,
    }));

  it("lists the first five left-out rows and counts the rest", () => {
    expect(vaultImportProblemList(problems(7))).toEqual({ shown: problems(5), more: 2 });
    expect(vaultImportProblemList(problems(5))).toEqual({ shown: problems(5), more: 0 });
    expect(vaultImportProblemList([])).toEqual({ shown: [], more: 0 });
  });
});
