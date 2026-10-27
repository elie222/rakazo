import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { errorText, loadFailureKind } from "./user-error";

const withStatus = (status: number) =>
  Object.defineProperty(new Error("Something went wrong. Try again."), "status", { value: status });

describe("loadFailureKind", () => {
  it("names the cause when the error carries one", () => {
    expect(loadFailureKind(new TypeError("Network request failed"))).toBe("offline");
    expect(loadFailureKind(withStatus(503))).toBe("offline");
    expect(loadFailureKind(withStatus(401))).toBe("session");
    expect(loadFailureKind(withStatus(500))).toBe("server");
  });

  it("leaves other failures to their message", () => {
    expect(loadFailureKind(withStatus(400))).toBe("other");
    expect(loadFailureKind(new Error("Could not save the default space"))).toBe("other");
  });
});

it("recognizes image compatibility errors from old clients and new servers", () => {
  expect(errorText(new Error(MODEL_IMAGE_INPUT_ERROR))).toBe(MODEL_IMAGE_INPUT_ERROR);
  expect(errorText(`  ${MODEL_IMAGE_INPUT_ERROR}  `)).toBe(MODEL_IMAGE_INPUT_ERROR);
});
