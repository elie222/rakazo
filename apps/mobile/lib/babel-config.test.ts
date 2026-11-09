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

describe("async arrow rest pattern transform", () => {
  it("moves a destructured rest parameter of an async arrow into the body", () => {
    expect(transform("f = async (...[input, options = {}]) => input;")).toBe(
      "f = async (..._args) => { var [input, options = {}] = _args; return input; };",
    );
    expect(transform("f = async (proc, ...[body]) => { await proc(body); };")).toBe(
      "f = async (proc, ..._args) => { var [body] = _args; await proc(body); };",
    );
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
