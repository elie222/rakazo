import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { ThreadTarget } from "../thread-target.js";
import { releaseComputerControl } from "./computer.js";
import { takeoverReleaser } from "./threads.js";

vi.mock("./computer.js", () => ({ releaseComputerControl: vi.fn().mockResolvedValue(undefined) }));

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

describe("takeoverReleaser", () => {
  const findUnique = vi.fn();
  const deps = { prisma: { run: { findUnique } } } as unknown as RouterDeps;

  beforeEach(() => {
    findUnique.mockReset();
    vi.mocked(releaseComputerControl).mockClear();
  });

  it("hands the screen back to the bot of a direct chat", async () => {
    const target = { kind: "bot", botId: "bot-1" } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-1");
    expect(releaseComputerControl).toHaveBeenCalledWith(deps, actor, "bot-1", "done", "run-1");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("hands the screen back to the group member whose run the reply steers", async () => {
    findUnique.mockResolvedValue({ botId: "bot-2" });
    const target = { kind: "group", memberBotIds: ["bot-1", "bot-2"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-2");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-2", spaceId: "space-1" },
      select: { botId: true },
    });
    expect(releaseComputerControl).toHaveBeenCalledWith(deps, actor, "bot-2", "done", "run-2");
  });

  it("releases nothing when the run is gone", async () => {
    findUnique.mockResolvedValue(null);
    const target = { kind: "group", memberBotIds: ["bot-1"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-3");
    expect(releaseComputerControl).not.toHaveBeenCalled();
  });
});
