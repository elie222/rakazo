import { expect, it } from "vitest";
import { appContract } from "../index.js";

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

it("stores an artifact name without the spaces around it", () => {
  expect(create["~standard"].validate(upload("  Report  "))).toMatchObject({
    value: expect.objectContaining({ name: "Report" }),
  });
});
