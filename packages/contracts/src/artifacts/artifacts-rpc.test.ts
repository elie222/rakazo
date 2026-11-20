import { expect, it } from "vitest";
import { appContract } from "../index.js";
import { ConnectionLabelSchema } from "../integrations/connections.js";

const create = appContract.artifacts.create["~orpc"].inputSchema!;
const upload = (name: string) => ({
  botId: "bot-1",
  name,
  mimeType: "text/plain",
  contentBase64: "aGk=",
});

it("refuses an artifact name that is only whitespace", () => {
  expect(create["~standard"].validate(upload("   "))).toMatchObject({ issues: expect.any(Array) });
});

it("preserves a nonblank artifact name exactly for its version history", () => {
  expect(create["~standard"].validate(upload("  Report  "))).toMatchObject({
    value: expect.objectContaining({ name: "  Report  " }),
  });
});

it.each(["\u200B", "\u200C", "\u200D", "\u2060", "👩\u200D💻"])(
  "preserves non-whitespace names accepted by shared name validation: %j",
  (name) => {
    expect(ConnectionLabelSchema.safeParse(name).success).toBe(true);
    expect(create["~standard"].validate(upload(name))).toMatchObject({
      value: expect.objectContaining({ name }),
    });
  },
);
