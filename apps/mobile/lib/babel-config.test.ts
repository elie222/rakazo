import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const babel = require(
  require.resolve("@babel/core", { paths: [require.resolve("expo/package.json")] }),
) as {
  transformSync: (source: string, options: object) => { code?: string | null } | null;
};
const config = require("../babel.config.js") as (api: { cache: (value: boolean) => void }) => {
  plugins: unknown[];
};
const [plugin] = config({ cache: () => {} }).plugins;

function transform(source: string) {
  return babel
    .transformSync(source, { babelrc: false, configFile: false, plugins: [plugin] })
    ?.code?.replace(/\s+/g, " ");
}

/** Whether the code still has an async arrow whose rest parameter is a pattern. */
function hasRejectedShape(source: string) {
  let found = false;
  const detect = {
    visitor: {
      ArrowFunctionExpression(path: {
        node: { async: boolean; params: { type: string; argument?: { type: string } }[] };
      }) {
        const rest = path.node.params.at(-1);
        if (path.node.async && rest?.type === "RestElement" && rest.argument?.type !== "Identifier")
          found = true;
      },
    },
  };
  babel.transformSync(source, { babelrc: false, configFile: false, plugins: [() => detect] });
  return found;
}

/** Runs `f = <arrow>` with an outer `helper` binding and reports how the call settles. */
async function settle(source: string, args: unknown[]) {
  const f = new Function(`const helper = "outer"; let f; ${source} return f;`)() as (
    ...values: unknown[]
  ) => Promise<unknown>;
  return f(...args).then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.constructor.name }),
  );
}

describe("async arrow rest pattern transform", () => {
  it("spreads an array rest pattern into ordinary parameters", () => {
    expect(transform("f = async (...[input, options = {}]) => input;")).toBe(
      "f = async (input, options = {}) => input;",
    );
    expect(transform("f = async (proc, ...[body, options]) => proc(body, options);")).toBe(
      "f = async (proc, body, options) => proc(body, options);",
    );
    expect(transform("f = async (...[, b, ...rest]) => b;")).toBe(
      "f = async (_hole, b, ...rest) => b;",
    );
  });

  it("moves any other pattern into an inner async arrow's parameter", () => {
    expect(transform("f = async (...{ length }) => length;")).toBe(
      "f = async (..._args) => (async ({ length }) => length)(_args);",
    );
  });

  it.each([
    ["defaults", "f = async (...[input, options = {}]) => [input, options];", [1]],
    [
      "leading parameters",
      "f = async (proc, ...[body, rest]) => proc(body, rest);",
      [Math.max, 2, 3],
    ],
    // Defaults cannot see body declarations, so `helper` stays the outer binding.
    [
      "body declarations",
      "f = async (...[cb = helper]) => { function helper() {} return cb; };",
      [],
    ],
    ["temporal dead zone", "f = async (...[a = b, b]) => a;", []],
    ["a body redeclaring a name", "f = async (...[a]) => { var a = a + 1; return a; };", [1]],
    ["holes", "f = async (...[, b]) => b;", [1, 2]],
    ["a nested rest", "f = async (...[a, ...rest]) => [a, rest];", [1, 2, 3]],
    ["a nested array rest", "f = async (...[a, ...[b = helper]]) => [a, b];", [1]],
    ["an object pattern", "f = async (...{ length }) => length;", [1, 2]],
    [
      "object pattern defaults",
      "f = async (...{ 0: x = helper }) => { function helper() {} return x; };",
      [],
    ],
    ["a nested object rest", "f = async (...[a, ...{ length }]) => [a, length];", [1, 2, 3]],
  ])("keeps the original result with %s", async (_label, source, args) => {
    const rewritten = transform(source) ?? "";
    expect(hasRejectedShape(source)).toBe(true);
    expect(hasRejectedShape(rewritten)).toBe(false);
    expect(await settle(rewritten, args)).toEqual(await settle(source, args));
  });

  it("leaves other functions alone", () => {
    for (const source of [
      "f = async (...args) => args;",
      "f = (...[a]) => a;",
      "f = async function (...[a]) { return a; };",
    ]) {
      expect(transform(source)).toBe(source);
    }
  });
});
