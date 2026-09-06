import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks live page browser protocol failure handling offline", () => {
  const tests = fileURLToPath(new URL("../../computer/test_page_browser.py", import.meta.url));
  expect(() => execFileSync("python3", [tests], { timeout: 10_000, stdio: "pipe" })).not.toThrow();
});
