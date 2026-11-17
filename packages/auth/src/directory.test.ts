import { readFileSync } from "node:fs";
import { scim } from "@better-auth/scim";
import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";

const PRISMA_TYPES: Record<string, string> = {
  string: "String",
  number: "Int",
  boolean: "Boolean",
  date: "DateTime",
};

/** Each Prisma model's scalar columns as `name: Type` or `name: Type?`, relations left out. */
function prismaModels(schema: string): Map<string, string[]> {
  const models = new Map<string, string[]>();
  for (const [, name, body] of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const columns = body!
      .split("\n")
      .map((line) =>
        /^\s+(\w+)\s+(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)(\??)(?:\s|$)/.exec(
          line,
        ),
      )
      .filter((match) => match !== null)
      .map(([, column, type, optional]) => `${column}: ${type}${optional}`);
    models.set(name!, columns);
  }
  return models;
}

describe("directory provisioning tables", () => {
  it("match the SCIM plugin's schema, which reads and writes them directly", () => {
    const plugin = scim({
      connections: [
        {
          id: "directory",
          credentials: [
            { type: "bearer", id: "operator", token: "t".repeat(40), scopes: ["scim.users.read"] },
          ],
        },
      ],
    });
    const tables = Object.values(getAuthTables({ plugins: [plugin] })).filter((table) =>
      table.modelName.startsWith("scim"),
    );
    expect(tables.length).toBeGreaterThan(0);
    const models = prismaModels(
      readFileSync(new URL("../../db/prisma/schema.prisma", import.meta.url), "utf8"),
    );
    for (const table of tables) {
      const model = `${table.modelName[0]!.toUpperCase()}${table.modelName.slice(1)}`;
      const expected = [
        "id: String",
        ...Object.entries(table.fields).map(
          ([field, { type, required }]) =>
            `${field}: ${PRISMA_TYPES[String(type)] ?? String(type)}${required === false ? "?" : ""}`,
        ),
      ];
      expect(models.get(model)?.sort(), model).toEqual(expected.sort());
    }
  });
});
