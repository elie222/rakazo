import { describe, expect, it } from "vitest";
import { buildShareManifest } from "./bot-share.js";

describe("buildShareManifest", () => {
  it("copies bot config fields without ids or credentials", () => {
    const manifest = buildShareManifest(
      {
        name: "Chief",
        title: "Planner",
        description: "Plans work",
        instructions: "Plan carefully",
        color: "#2965EC",
        notifyOnFinish: true,
        computerMode: "dedicated",
      },
      [{ name: "Daily", prompt: "Check inbox", crons: ["0 9 * * *"], timezone: "UTC" }],
    );
    expect(manifest.version).toBe("rakazo.share/v1");
    expect(manifest.name).toBe("Chief");
    expect(manifest.routines).toHaveLength(1);
    expect(manifest).not.toHaveProperty("history");
    expect(manifest).not.toHaveProperty("files");
  });
});
