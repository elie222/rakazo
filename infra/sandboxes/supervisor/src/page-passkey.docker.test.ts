import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Build the computer image first. This opt-in check needs Docker and the network: it creates a
// passkey on webauthn.io and signs in with it from a fresh browser in the image.
it.skipIf(process.env.VERIFY_DOCKER_PASSKEY_SITE !== "1")(
  "creates a passkey on a real site and signs in with it from a fresh browser",
  () => {
    const name = `rakazo-passkey-site-test-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 150_000 });
    try {
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--shm-size=512m",
        process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
      );
      docker(
        "cp",
        fileURLToPath(new URL("../../computer/test_page_passkey_site.py", import.meta.url)),
        `${name}:/tmp/test_page_passkey_site.py`,
      );
      expect(docker("exec", name, "python3", "/tmp/test_page_passkey_site.py")).toContain(
        "PASS: passkey created",
      );
    } finally {
      try {
        docker("rm", "-f", name);
      } catch {
        // Cleanup must not replace the original test failure.
      }
    }
  },
  180_000,
);
